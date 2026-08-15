import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const cleanEnvironmentManifestPath = resolve(
  scriptDirectory,
  "clean-environment-manifest.json"
);

const sha256Pattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const safeDockerNamePattern = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
const expectedPins = Object.freeze({
  base_image_digest:
    "sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54",
  codex_integrity:
    "sha512-EQLEXecAG2ptxI7UpBMo2TR/ga5596/c/OsYF/0LoUDh5JANZ7IoGqlzBEWbuEVQ76JePIbtTW/ihCkp1a7Z3w==",
  codex_version: "0.147.0",
  node_archive_sha256:
    "88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a",
  node_archive_url:
    "https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz",
  node_version: "22.22.2",
  pnpm_version: "10.29.2",
  tailscale_deb_sha256:
    "036af7f0f3ed78ecf091bffbe3518f57a76c576d2ffa8d70e41d79d290878189",
  tailscale_deb_url:
    "https://pkgs.tailscale.com/stable/ubuntu/pool/tailscale_1.98.8_amd64.deb",
  tailscale_version: "1.98.8"
});
const expectedBounds = Object.freeze({
  acceptance_ms: 1_800_000,
  bootstrap_ms: 900_000,
  command_output_bytes: 1_048_576,
  container_stop_seconds: 30,
  host_command_ms: 120_000,
  http_body_bytes: 2_097_152,
  image_build_ms: 1_200_000,
  poll_ms: 100,
  readiness_ms: 90_000
});
const expectedRootKeys = [
  "base_image",
  "bounds",
  "codex",
  "container",
  "contracts",
  "evidence_fields",
  "node",
  "package_versions",
  "pnpm_version",
  "schema_version",
  "tailscale",
  "task_id"
];
const expectedEvidenceFields = [
  "schema_version",
  "task_id",
  "criteria_commit",
  "source_commit",
  "host",
  "container",
  "toolchain",
  "clean_source",
  "packages",
  "foreground",
  "service",
  "tailscale",
  "cleanup",
  "limits"
];

export function loadCleanEnvironmentManifest(
  path = cleanEnvironmentManifestPath
) {
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 16_384) {
    throw new TypeError("Clean-environment manifest exceeds its byte bound.");
  }
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new TypeError("Clean-environment manifest is not valid JSON.");
  }
  return parseCleanEnvironmentManifest(candidate);
}

export function parseCleanEnvironmentManifest(candidate) {
  requireRecord(candidate, "Clean-environment manifest");
  requireExactKeys(candidate, expectedRootKeys, "Clean-environment manifest");
  requireExact(candidate.schema_version, 1, "Manifest schema version");
  requireExact(candidate.task_id, "IFC-V1-058", "Manifest task id");

  requireRecord(candidate.contracts, "Acceptance contracts");
  requireExactKeys(
    candidate.contracts,
    [
      "package_manifest_schema",
      "required_host_commands",
      "required_user_commands",
      "source_lockfile"
    ],
    "Acceptance contracts"
  );
  requireExact(
    candidate.contracts.package_manifest_schema,
    6,
    "Package manifest schema"
  );
  requireExact(
    candidate.contracts.source_lockfile,
    "pnpm-lock.yaml",
    "Source lockfile"
  );
  requireExactStringArray(
    candidate.contracts.required_host_commands,
    ["docker", "git", "sha256sum"],
    "Required host commands"
  );
  requireExactStringArray(
    candidate.contracts.required_user_commands,
    ["corepack", "git", "node", "npm", "pnpm", "systemctl", "tailscale"],
    "Required user commands"
  );

  requireRecord(candidate.base_image, "Base image");
  requireExactKeys(
    candidate.base_image,
    ["architecture", "digest", "os", "reference", "version"],
    "Base image"
  );
  requireExact(
    candidate.base_image.reference,
    `ubuntu@${expectedPins.base_image_digest}`,
    "Base image reference"
  );
  if (!imageDigestPattern.test(candidate.base_image.digest)) {
    throw new TypeError("Base image digest is invalid.");
  }
  requireExact(
    candidate.base_image.digest,
    expectedPins.base_image_digest,
    "Base image digest"
  );
  requireExact(candidate.base_image.os, "ubuntu", "Base image OS");
  requireExact(candidate.base_image.version, "24.04", "Base image version");
  requireExact(
    candidate.base_image.architecture,
    "amd64",
    "Base image architecture"
  );

  requireRecord(candidate.node, "Node prerequisite");
  requireExactKeys(
    candidate.node,
    ["archive_sha256", "archive_url", "version"],
    "Node prerequisite"
  );
  requireExact(candidate.node.version, expectedPins.node_version, "Node version");
  requireHttpsUrl(candidate.node.archive_url, "nodejs.org", "Node archive URL");
  requireSha256(candidate.node.archive_sha256, "Node archive SHA-256");
  requireExact(
    candidate.node.archive_url,
    expectedPins.node_archive_url,
    "Node archive URL"
  );
  requireExact(
    candidate.node.archive_sha256,
    expectedPins.node_archive_sha256,
    "Node archive SHA-256"
  );
  requireExact(
    candidate.pnpm_version,
    expectedPins.pnpm_version,
    "pnpm version"
  );

  requireRecord(candidate.codex, "Codex prerequisite");
  requireExactKeys(
    candidate.codex,
    ["integrity", "package", "version"],
    "Codex prerequisite"
  );
  requireExact(candidate.codex.package, "@openai/codex", "Codex package");
  requireExact(
    candidate.codex.version,
    expectedPins.codex_version,
    "Codex version"
  );
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(candidate.codex.integrity)) {
    throw new TypeError("Codex package integrity is invalid.");
  }
  requireExact(
    candidate.codex.integrity,
    expectedPins.codex_integrity,
    "Codex package integrity"
  );

  requireRecord(candidate.tailscale, "Tailscale prerequisite");
  requireExactKeys(
    candidate.tailscale,
    ["deb_sha256", "deb_url", "version"],
    "Tailscale prerequisite"
  );
  requireExact(
    candidate.tailscale.version,
    expectedPins.tailscale_version,
    "Tailscale version"
  );
  requireHttpsUrl(
    candidate.tailscale.deb_url,
    "pkgs.tailscale.com",
    "Tailscale package URL"
  );
  requireSha256(candidate.tailscale.deb_sha256, "Tailscale package SHA-256");
  requireExact(
    candidate.tailscale.deb_url,
    expectedPins.tailscale_deb_url,
    "Tailscale package URL"
  );
  requireExact(
    candidate.tailscale.deb_sha256,
    expectedPins.tailscale_deb_sha256,
    "Tailscale package SHA-256"
  );

  if (
    !Array.isArray(candidate.package_versions) ||
    candidate.package_versions.length !== 2 ||
    candidate.package_versions.some(
      (version) => !exactVersionPattern.test(version)
    ) ||
    candidate.package_versions[0] === candidate.package_versions[1]
  ) {
    throw new TypeError("Clean-environment package versions are invalid.");
  }

  requireRecord(candidate.container, "Container contract");
  requireExactKeys(
    candidate.container,
    [
      "checkout",
      "evidence_dir",
      "gid",
      "home",
      "image_tag_prefix",
      "name",
      "runtime_dir",
      "tailscale_mount",
      "uid",
      "user"
    ],
    "Container contract"
  );
  for (const field of ["name", "image_tag_prefix"]) {
    if (!safeDockerNamePattern.test(candidate.container[field])) {
      throw new TypeError(`Container ${field} is invalid.`);
    }
  }
  requireExact(candidate.container.user, "ubuntu", "Container user");
  requireExact(candidate.container.uid, 1000, "Container uid");
  requireExact(candidate.container.gid, 1000, "Container gid");
  requireExact(candidate.container.home, "/home/ubuntu", "Container home");
  requireExact(
    candidate.container.checkout,
    "/home/ubuntu/HostDeck",
    "Container checkout"
  );
  requireExact(
    candidate.container.runtime_dir,
    "/run/user/1000",
    "Container runtime directory"
  );
  requireExact(
    candidate.container.evidence_dir,
    "/evidence",
    "Container evidence directory"
  );
  requireExact(
    candidate.container.tailscale_mount,
    "/host-tailscale",
    "Container Tailscale mount"
  );

  requireRecord(candidate.bounds, "Acceptance bounds");
  requireExactKeys(
    candidate.bounds,
    [
      "acceptance_ms",
      "bootstrap_ms",
      "command_output_bytes",
      "container_stop_seconds",
      "host_command_ms",
      "http_body_bytes",
      "image_build_ms",
      "poll_ms",
      "readiness_ms"
    ],
    "Acceptance bounds"
  );
  for (const [field, value] of Object.entries(candidate.bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Acceptance bound ${field} is invalid.`);
    }
  }
  for (const [field, value] of Object.entries(expectedBounds)) {
    requireExact(candidate.bounds[field], value, `Acceptance bound ${field}`);
  }
  if (
    candidate.bounds.poll_ms > candidate.bounds.readiness_ms ||
    candidate.bounds.readiness_ms > candidate.bounds.acceptance_ms ||
    candidate.bounds.bootstrap_ms > candidate.bounds.acceptance_ms ||
    candidate.bounds.host_command_ms > candidate.bounds.acceptance_ms ||
    candidate.bounds.command_output_bytes > candidate.bounds.http_body_bytes
  ) {
    throw new TypeError("Acceptance bounds are contradictory.");
  }

  if (
    !Array.isArray(candidate.evidence_fields) ||
    !sameArray(candidate.evidence_fields, expectedEvidenceFields)
  ) {
    throw new TypeError("Clean-environment evidence fields are invalid.");
  }

  return deepFreeze(structuredClone(candidate));
}

export function parseCleanGitStatus(status) {
  if (
    typeof status !== "string" ||
    Buffer.byteLength(status, "utf8") > 1_048_576
  ) {
    throw new TypeError("Clean Git status is invalid.");
  }
  const entries = status.split("\0").filter((entry) => entry.length > 0);
  let excludedPngCount = 0;
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (
      ![" M", "M ", "MM"].includes(code) ||
      !path.startsWith("artifacts/") ||
      !path.endsWith(".png") ||
      path.includes("\0") ||
      path.includes("\n") ||
      path.split("/").includes("..")
    ) {
      throw new TypeError("Clean Git status contains a runtime input.");
    }
    excludedPngCount += 1;
  }
  return Object.freeze({ excluded_png_count: excludedPngCount });
}

export function parseDockerImageIdentity(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1_048_576) {
    throw new TypeError("Docker image inspection is invalid.");
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new TypeError("Docker image inspection is invalid.");
  }
  const value = Array.isArray(values) && values.length === 1 ? values[0] : null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.Id !== "string" ||
    !imageDigestPattern.test(value.Id) ||
    !Array.isArray(value.RepoDigests) ||
    value.RepoDigests.some((item) => typeof item !== "string")
  ) {
    throw new TypeError("Docker image inspection is invalid.");
  }
  return deepFreeze({ id: value.Id, repo_digests: [...value.RepoDigests] });
}

export function redactCleanDiagnostic(stdout, stderr, privateValues) {
  if (
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    !Array.isArray(privateValues) ||
    privateValues.length === 0 ||
    privateValues.length > 8 ||
    privateValues.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new TypeError("Clean diagnostic input is invalid.");
  }
  let value = `${stderr}\n${stdout}`;
  for (const privateValue of privateValues) {
    value = value.replaceAll(privateValue, "<private-path>");
  }
  return value.trim().replace(/[\r\n]+/gu, " | ").slice(0, 2_000);
}

export function classifyCleanInstallWarnings(stdout, stderr, allowNetworkTelemetry) {
  if (
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof allowNetworkTelemetry !== "boolean"
  ) {
    throw new TypeError("Clean install warning input is invalid.");
  }
  const warningLines = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bwarn(?:ing)?\b/iu.test(line));
  let allowedNetworkWarningCount = 0;
  for (const line of warningLines) {
    const match = /^WARN\s+Tarball download average speed \d+(?:\.\d+)? KiB\/s \(size \d+(?:\.\d+)? KiB\) is below \d+(?:\.\d+)? KiB\/s: (https:\/\/\S+) \(GET\)$/u.exec(
      line
    );
    if (!allowNetworkTelemetry || match?.[1] === undefined) {
      throw new TypeError("Clean install emitted an unsupported warning.");
    }
    let url;
    try {
      url = new URL(match[1]);
    } catch {
      throw new TypeError("Clean install emitted an unsupported warning.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname === "/"
    ) {
      throw new TypeError("Clean install emitted an unsupported warning.");
    }
    allowedNetworkWarningCount += 1;
  }
  return Object.freeze({
    allowed_network_warning_count: allowedNetworkWarningCount,
    install_warning_count: warningLines.length,
    unsupported_warning_count: 0
  });
}

export function parseCleanUserEvidence(candidate, manifest, expected) {
  const parsedManifest = parseCleanEnvironmentManifest(manifest);
  requireRecord(expected, "Expected evidence identity");
  requireExactKeys(
    expected,
    ["criteria_commit", "source_commit"],
    "Expected evidence identity"
  );
  for (const [field, value] of Object.entries(expected)) {
    if (!commitPattern.test(value)) {
      throw new TypeError(`Expected evidence ${field} is invalid.`);
    }
  }
  requireRecord(candidate, "Clean-user evidence");
  requireExactKeys(
    candidate,
    parsedManifest.evidence_fields,
    "Clean-user evidence"
  );
  requireExact(candidate.schema_version, 1, "Evidence schema version");
  requireExact(candidate.task_id, parsedManifest.task_id, "Evidence task id");
  requireExact(
    candidate.criteria_commit,
    expected.criteria_commit,
    "Evidence criteria commit"
  );
  requireExact(
    candidate.source_commit,
    expected.source_commit,
    "Evidence source commit"
  );
  for (const field of parsedManifest.evidence_fields.slice(4)) {
    requireRecord(candidate[field], `Evidence ${field}`);
  }
  validateHostEvidence(candidate.host);
  validateContainerEvidence(candidate.container, parsedManifest);
  validateToolchainEvidence(candidate.toolchain, parsedManifest);
  validateCleanSourceEvidence(candidate.clean_source);
  validatePackageEvidence(candidate.packages, parsedManifest);
  validateForegroundEvidence(candidate.foreground, parsedManifest);
  validateServiceEvidence(candidate.service, parsedManifest);
  validateTailscaleEvidence(candidate.tailscale, parsedManifest);
  validateCleanupEvidence(candidate.cleanup);
  validateLimitEvidence(candidate.limits);
  requireExact(candidate.cleanup.complete, true, "Evidence cleanup state");
  requireExact(candidate.limits.shared_kernel, true, "Shared-kernel limit");
  requireExact(candidate.limits.phone_tested, false, "Phone-test limit");
  requireExact(candidate.limits.release_ready, false, "Release-ready limit");
  assertNoPrivateEvidence(candidate);
  return deepFreeze(structuredClone(candidate));
}

function validateHostEvidence(value) {
  requireExactKeys(
    value,
    [
      "architecture",
      "docker_server_version",
      "excluded_uncommitted_png_count",
      "kernel_shared",
      "os",
      "os_version"
    ],
    "Host evidence"
  );
  requireExact(value.architecture, "x64", "Host architecture");
  requireVersionText(value.docker_server_version, "Docker server version");
  requireNonNegativeInteger(
    value.excluded_uncommitted_png_count,
    "Excluded PNG count"
  );
  requireExact(value.kernel_shared, true, "Host shared-kernel state");
  requireBoundedString(value.os, "Host OS");
  requireBoundedString(value.os_version, "Host OS version");
}

function validateContainerEvidence(value, manifest) {
  requireExactKeys(
    value,
    [
      "architecture",
      "base_digest",
      "cgroup_namespace",
      "image_id",
      "mounts",
      "network_mode",
      "os",
      "os_version",
      "pid_namespace",
      "privileged_validation_infrastructure",
      "root_bootstrap",
      "system_manager",
      "systemd_version",
      "uid",
      "user_manager"
    ],
    "Container evidence"
  );
  requireExact(value.architecture, manifest.base_image.architecture, "Container architecture");
  requireExact(value.base_digest, manifest.base_image.digest, "Container base digest");
  requireExact(value.cgroup_namespace, "private", "Container cgroup namespace");
  if (typeof value.image_id !== "string" || !imageDigestPattern.test(value.image_id)) {
    throw new TypeError("Container image id is invalid.");
  }
  const expectedMounts = [
    { destination: "/evidence", read_only: false, type: "bind" },
    { destination: "/host-tailscale", read_only: true, type: "bind" },
    { destination: "/source", read_only: true, type: "bind" }
  ];
  if (!Array.isArray(value.mounts) || canonicalJson(value.mounts) !== canonicalJson(expectedMounts)) {
    throw new TypeError("Container mounts are invalid.");
  }
  requireExact(value.network_mode, "default_bridge", "Container network mode");
  requireExact(value.os, manifest.base_image.os, "Container OS");
  requireExact(value.os_version, manifest.base_image.version, "Container OS version");
  requireExact(value.pid_namespace, "private", "Container PID namespace");
  requireExact(
    value.privileged_validation_infrastructure,
    true,
    "Container validation privilege"
  );
  requireRecord(value.root_bootstrap, "Root bootstrap evidence");
  requireExactKeys(
    value.root_bootstrap,
    [
      "actions",
      "node_archive_sha256",
      "product_lifecycle_actions",
      "tailscale_daemon",
      "tailscale_package_version",
      "uid"
    ],
    "Root bootstrap evidence"
  );
  requireExactStringArray(
    value.root_bootstrap.actions,
    [
      "install_os_prerequisites",
      "verify_node_archive",
      "install_tailscale_client",
      "disable_tailscale_daemon",
      "start_uid_1000_manager"
    ],
    "Root bootstrap actions"
  );
  requireExact(
    value.root_bootstrap.node_archive_sha256,
    manifest.node.archive_sha256,
    "Root Node archive hash"
  );
  requireExact(value.root_bootstrap.product_lifecycle_actions, 0, "Root product actions");
  requireExact(
    value.root_bootstrap.tailscale_daemon,
    "disabled_inactive",
    "Root Tailscale daemon state"
  );
  requireExact(
    value.root_bootstrap.tailscale_package_version,
    manifest.tailscale.version,
    "Root Tailscale package version"
  );
  requireExact(value.root_bootstrap.uid, manifest.container.uid, "Root bootstrap uid");
  requireExact(value.system_manager, "running", "Container system manager");
  requireBoundedString(value.systemd_version, "Container systemd version");
  requireExact(value.uid, manifest.container.uid, "Container uid");
  requireExact(value.user_manager, "running", "Container user manager");
}

function validateToolchainEvidence(value, manifest) {
  requireExactKeys(
    value,
    [
      "codex",
      "codex_integrity_verified",
      "corepack",
      "git",
      "native_modules_loaded",
      "node",
      "npm",
      "pnpm",
      "systemd",
      "tailscale"
    ],
    "Toolchain evidence"
  );
  requireExact(value.codex, manifest.codex.version, "Evidence Codex version");
  requireExact(value.codex_integrity_verified, true, "Codex integrity proof");
  requireVersionText(value.corepack, "Corepack version");
  requireVersionText(value.git, "Git version");
  requireExact(value.native_modules_loaded, true, "Native module proof");
  requireExact(value.node, manifest.node.version, "Evidence Node version");
  requireVersionText(value.npm, "npm version");
  requireExact(value.pnpm, manifest.pnpm_version, "Evidence pnpm version");
  requireBoundedString(value.systemd, "Evidence systemd version");
  requireExact(value.tailscale, manifest.tailscale.version, "Evidence Tailscale version");
}

function validateCleanSourceEvidence(value) {
  requireExactKeys(
    value,
    [
      "bootstrap",
      "commit",
      "dist_preexisting",
      "frozen_install",
      "git_tracked_clean",
      "host_build_output_mounted",
      "host_dependency_tree_mounted",
      "lockfile_sha256",
      "node_modules_preexisting",
      "source_bundle_bytes",
      "source_bundle_sha256"
    ],
    "Clean-source evidence"
  );
  if (typeof value.commit !== "string" || !commitPattern.test(value.commit)) {
    throw new TypeError("Clean-source commit is invalid.");
  }
  for (const field of [
    "dist_preexisting",
    "host_build_output_mounted",
    "host_dependency_tree_mounted",
    "node_modules_preexisting"
  ]) {
    requireExact(value[field], false, `Clean-source ${field}`);
  }
  requireExact(value.frozen_install, true, "Frozen install proof");
  requireExact(value.git_tracked_clean, true, "Clean Git proof");
  requireSha256(value.lockfile_sha256, "Lockfile SHA-256");
  requirePositiveInteger(value.source_bundle_bytes, "Source bundle bytes");
  requireSha256(value.source_bundle_sha256, "Source bundle SHA-256");
  requireRecord(value.bootstrap, "Bootstrap evidence");
  requireExactKeys(
    value.bootstrap,
    [
      "codex_install_ms",
      "corepack_ms",
      "direct_contract_test_ms",
      "frozen_install_ms",
      "allowed_network_warning_count",
      "install_warning_count",
      "node_extract_ms",
      "source_clone_ms",
      "total_ms",
      "unsupported_warning_count"
    ],
    "Bootstrap evidence"
  );
  for (const [field, duration] of Object.entries(value.bootstrap)) {
    requireNonNegativeInteger(duration, `Bootstrap ${field}`);
  }
  requireExact(
    value.bootstrap.install_warning_count,
    value.bootstrap.allowed_network_warning_count,
    "Bootstrap classified warning count"
  );
  requireExact(
    value.bootstrap.unsupported_warning_count,
    0,
    "Bootstrap unsupported warning count"
  );
}

function validatePackageEvidence(value, manifest) {
  requireExactKeys(value, ["deterministic_primary", "primary", "upgrade"], "Package evidence");
  requireExact(value.deterministic_primary, true, "Deterministic package proof");
  requirePackageIdentity(value.primary, manifest.package_versions[0], "Primary package");
  requirePackageIdentity(value.upgrade, manifest.package_versions[1], "Upgrade package");
}

function requirePackageIdentity(value, version, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    [
      "content_sha256",
      "deferrals",
      "duration_ms",
      "entry_count",
      "manifest_sha256",
      "output_count",
      "package_version",
      "source_count",
      "verified_entry_count",
      "web_file_count",
      "web_manifest_sha256",
      "web_sha256"
    ],
    label
  );
  requireSha256(value.content_sha256, `${label} content SHA-256`);
  requireSha256(value.manifest_sha256, `${label} manifest SHA-256`);
  requireSha256(value.web_manifest_sha256, `${label} web manifest SHA-256`);
  requireSha256(value.web_sha256, `${label} web SHA-256`);
  requireExact(value.package_version, version, `${label} version`);
  if (!Array.isArray(value.deferrals) || value.deferrals.length !== 0) {
    throw new TypeError(`${label} deferrals are invalid.`);
  }
  requireNonNegativeInteger(value.duration_ms, `${label} duration`);
  for (const field of [
    "entry_count",
    "output_count",
    "source_count",
    "verified_entry_count",
    "web_file_count"
  ]) {
    requirePositiveInteger(value[field], `${label} ${field}`);
  }
  requireExact(value.entry_count, value.verified_entry_count, `${label} verified entries`);
}

function validateForegroundEvidence(value, manifest) {
  requireExactKeys(
    value,
    [
      "duration_ms",
      "http",
      "local_ready",
      "package_version",
      "processes",
      "remote_unavailable",
      "socket_mode",
      "tcp_listener",
      "web_manifest_sha256",
      "web_sha256"
    ],
    "Foreground evidence"
  );
  requireNonNegativeInteger(value.duration_ms, "Foreground duration");
  requireExact(value.local_ready, true, "Foreground local readiness");
  requireExact(value.remote_unavailable, true, "Foreground remote state");
  requireExact(value.package_version, manifest.package_versions[0], "Foreground package version");
  requireExact(value.socket_mode, "0600", "Foreground socket mode");
  requireExact(value.tcp_listener, "127.0.0.1", "Foreground listener");
  requireSha256(value.web_manifest_sha256, "Foreground web manifest SHA-256");
  requireSha256(value.web_sha256, "Foreground web SHA-256");
  validateProcessEvidence(value.processes, manifest);
  validateHttpEvidence(value.http, manifest.package_versions[0], "Foreground HTTP");
}

function validateProcessEvidence(value, manifest) {
  requireRecord(value, "Foreground process evidence");
  requireExactKeys(
    value,
    [
      "app_server_launcher_trees",
      "app_server_processes",
      "app_server_tree_processes",
      "arguments_verified",
      "hostdeck_main_pid",
      "hostdeck_main_processes",
      "uid",
      "zero_capabilities"
    ],
    "Foreground process evidence"
  );
  requireExact(value.app_server_launcher_trees, 1, "App-server launcher trees");
  requirePositiveInteger(value.app_server_processes, "App-server process count");
  requirePositiveInteger(value.app_server_tree_processes, "App-server tree count");
  requireExact(value.arguments_verified, true, "Foreground argument proof");
  requirePositiveInteger(value.hostdeck_main_pid, "Foreground HostDeck PID");
  requireExact(value.hostdeck_main_processes, 1, "Foreground HostDeck process count");
  requireExact(value.uid, manifest.container.uid, "Foreground uid");
  requireExact(value.zero_capabilities, true, "Foreground capability proof");
}

function validateHttpEvidence(value, version, label) {
  requireRecord(value, label);
  requireExactKeys(
    value,
    [
      "compatibility",
      "index_sha256",
      "local_ready",
      "no_store_status",
      "package_version",
      "remote_ready",
      "security_headers",
      "web_identity_sha256",
      "web_manifest_sha256"
    ],
    label
  );
  requireExact(value.compatibility, "supported", `${label} compatibility`);
  requireSha256(value.index_sha256, `${label} index SHA-256`);
  requireExact(value.local_ready, true, `${label} local readiness`);
  requireExact(value.no_store_status, true, `${label} no-store proof`);
  requireExact(value.package_version, version, `${label} package version`);
  requireExact(value.remote_ready, false, `${label} remote state`);
  requireExact(value.security_headers, true, `${label} security headers`);
  requireSha256(value.web_identity_sha256, `${label} web identity SHA-256`);
  requireSha256(value.web_manifest_sha256, `${label} web manifest SHA-256`);
}

function validateServiceEvidence(value, manifest) {
  const booleanFields = [
    "active_checkpoint",
    "active_upgrade",
    "active_upgrade_hostdeck_restarted",
    "active_upgrade_preserved_codex",
    "active_upgrade_preserved_socket",
    "codex_loss_reported_not_ready",
    "codex_restart_changed_pid",
    "exact_install_inventory",
    "foreground_service_http_parity",
    "hostdeck_restart_preserved_codex",
    "idempotent_install_start_stop",
    "install_initially_inactive",
    "installed_command_used_for_uninstall",
    "invalid_lifecycle_order_rejected",
    "observed_restart_preserved_codex",
    "repeated_uninstall_unchanged",
    "root_install_absent",
    "socket_changed_on_codex_restart",
    "socket_preserved_on_hostdeck_restart",
    "state_config_codex_preserved",
    "tailscale_observation_restart_ready",
    "uninstall_not_found_units"
  ];
  requireExactKeys(
    value,
    [
      ...booleanFields,
      "codex_pid_after_restart",
      "codex_pid_initial",
      "duration_ms",
      "hostdeck_pid_after_restart",
      "hostdeck_pid_initial",
      "observed_phase_ms",
      "package_version",
      "release_retention_count",
      "unavailable_phase_ms",
      "uninstall_product_residue",
      "unit_inventory",
      "upgrade_package_version",
      "upgrade_web_sha256",
      "upgraded_http",
      "user_manager"
    ],
    "Service evidence"
  );
  for (const field of booleanFields) {
    requireExact(value[field], true, `Service ${field}`);
  }
  for (const field of [
    "codex_pid_after_restart",
    "codex_pid_initial",
    "hostdeck_pid_after_restart",
    "hostdeck_pid_initial"
  ]) {
    requirePositiveInteger(value[field], `Service ${field}`);
  }
  for (const field of ["duration_ms", "observed_phase_ms", "unavailable_phase_ms"]) {
    requireNonNegativeInteger(value[field], `Service ${field}`);
  }
  requireExact(value.package_version, manifest.package_versions[0], "Service package version");
  requireExact(value.release_retention_count, 2, "Service release retention");
  requireExact(value.uninstall_product_residue, 0, "Service uninstall residue");
  requireExact(
    value.upgrade_package_version,
    manifest.package_versions[1],
    "Service upgrade version"
  );
  requireSha256(value.upgrade_web_sha256, "Service upgrade web SHA-256");
  requireExact(value.user_manager, "running", "Service user manager");
  validateUnitInventory(value.unit_inventory, manifest);
  validateHttpEvidence(value.upgraded_http, manifest.package_versions[1], "Upgrade HTTP");
}

function validateUnitInventory(value, manifest) {
  requireRecord(value, "Unit inventory");
  requireExactKeys(
    value,
    [
      "codex_cgroup_processes",
      "codex_control_group",
      "codex_main_pid",
      "hostdeck_cgroup_processes",
      "hostdeck_control_group",
      "hostdeck_main_pid",
      "listener_count",
      "socket_owner_uid",
      "zero_capabilities"
    ],
    "Unit inventory"
  );
  requirePositiveInteger(value.codex_cgroup_processes, "Codex cgroup process count");
  requirePositiveInteger(value.codex_main_pid, "Codex main PID");
  requireExact(value.hostdeck_cgroup_processes, 1, "HostDeck cgroup process count");
  requirePositiveInteger(value.hostdeck_main_pid, "HostDeck main PID");
  requireExact(value.listener_count, 1, "Service listener count");
  requireExact(value.socket_owner_uid, manifest.container.uid, "Service socket uid");
  requireExact(value.zero_capabilities, true, "Service capability proof");
  for (const [field, suffix] of [
    ["codex_control_group", "/app.slice/hostdeck-codex.service"],
    ["hostdeck_control_group", "/app.slice/hostdeck.service"]
  ]) {
    requireBoundedString(value[field], `Unit inventory ${field}`);
    if (!value[field].endsWith(suffix)) {
      throw new TypeError(`Unit inventory ${field} is invalid.`);
    }
  }
}

function validateTailscaleEvidence(value, manifest) {
  requireExactKeys(
    value,
    [
      "client_version",
      "host_after_sha256",
      "host_before_sha256",
      "host_identity_unchanged",
      "initial_daemon_unavailable",
      "observation_only",
      "observed_identity_sha256",
      "profile_switch_calls",
      "raw_profile_data_recorded",
      "serve_mutation_calls"
    ],
    "Tailscale evidence"
  );
  requireExact(value.client_version, manifest.tailscale.version, "Tailscale client version");
  for (const field of [
    "host_after_sha256",
    "host_before_sha256",
    "observed_identity_sha256"
  ]) {
    requireSha256(value[field], `Tailscale ${field}`);
  }
  requireExact(
    value.host_after_sha256,
    value.host_before_sha256,
    "Tailscale host identity"
  );
  requireExact(
    value.observed_identity_sha256,
    value.host_before_sha256,
    "Tailscale observation coherence"
  );
  for (const field of [
    "host_identity_unchanged",
    "initial_daemon_unavailable",
    "observation_only"
  ]) {
    requireExact(value[field], true, `Tailscale ${field}`);
  }
  requireExact(value.profile_switch_calls, 0, "Tailscale profile switches");
  requireExact(value.raw_profile_data_recorded, false, "Tailscale raw profile state");
  requireExact(value.serve_mutation_calls, 0, "Tailscale Serve mutations");
}

function validateCleanupEvidence(value) {
  const fields = [
    "complete",
    "installed_command_absent",
    "lifecycle_coordination_retained",
    "processes_absent",
    "product_complete",
    "runtime_absent",
    "units_not_found"
  ];
  requireExactKeys(value, fields, "Cleanup evidence");
  for (const field of fields) {
    requireExact(value[field], true, `Cleanup ${field}`);
  }
}

function validateLimitEvidence(value) {
  requireExactKeys(
    value,
    ["independent_kernel_or_vm", "phone_tested", "release_ready", "shared_kernel"],
    "Limit evidence"
  );
  requireExact(value.independent_kernel_or_vm, false, "Independent-kernel limit");
  requireExact(value.phone_tested, false, "Phone-test limit");
  requireExact(value.release_ready, false, "Release-ready limit");
  requireExact(value.shared_kernel, true, "Shared-kernel limit");
}

export function createCleanEnvironmentDockerfile(manifest) {
  const value = parseCleanEnvironmentManifest(manifest);
  return `FROM ${value.base_image.reference}\n\
ENV container=docker\n\
RUN apt-get update \\\n && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\\n      build-essential ca-certificates curl dbus-user-session git iproute2 procps \\\n      python3 systemd systemd-sysv xz-utils \\\n && install -d -m 0755 /opt/hostdeck-bootstrap \\\n && curl -fsSL --proto '=https' --tlsv1.2 '${value.node.archive_url}' -o /opt/hostdeck-bootstrap/node.tar.xz \\\n && echo '${value.node.archive_sha256}  /opt/hostdeck-bootstrap/node.tar.xz' | sha256sum --check --strict \\\n && curl -fsSL --proto '=https' --tlsv1.2 '${value.tailscale.deb_url}' -o /opt/hostdeck-bootstrap/tailscale.deb \\\n && echo '${value.tailscale.deb_sha256}  /opt/hostdeck-bootstrap/tailscale.deb' | sha256sum --check --strict \\\n && DEBIAN_FRONTEND=noninteractive apt-get install -y /opt/hostdeck-bootstrap/tailscale.deb \\\n && systemctl disable tailscaled.service \\\n && install -d -o ${value.container.uid} -g ${value.container.gid} -m 0700 '${value.container.home}'\n\
RUN test "$(id -u ${value.container.user})" = '${value.container.uid}' \\\n && test "$(id -g ${value.container.user})" = '${value.container.gid}' \\\n && test "$(dpkg-query -W -f='\${Version}' tailscale)" = '${value.tailscale.version}'\n\
STOPSIGNAL SIGRTMIN+3\n\
CMD ["/sbin/init"]\n`;
}

export function createCleanEnvironmentDockerRunArgs(manifest, input) {
  const value = parseCleanEnvironmentManifest(manifest);
  requireRecord(input, "Docker run input");
  requireExactKeys(
    input,
    ["evidence_root", "image_tag", "source_root", "tailscale_root"],
    "Docker run input"
  );
  for (const field of ["evidence_root", "source_root", "tailscale_root"]) {
    requireAbsolutePath(input[field], `Docker run ${field}`);
  }
  if (!safeDockerNamePattern.test(input.image_tag.replace(":", "-"))) {
    throw new TypeError("Docker run image tag is invalid.");
  }
  return Object.freeze([
    "run",
    "--rm",
    "--detach",
    "--name",
    value.container.name,
    "--privileged",
    "--cgroupns=private",
    "--tmpfs",
    "/run:rw,nosuid,nodev,mode=755",
    "--tmpfs",
    "/run/lock:rw,nosuid,nodev,mode=755",
    "--mount",
    `type=bind,src=${input.source_root},dst=/source,readonly`,
    "--mount",
    `type=bind,src=${input.evidence_root},dst=${value.container.evidence_dir}`,
    "--mount",
    `type=bind,src=${input.tailscale_root},dst=${value.container.tailscale_mount},readonly`,
    input.image_tag
  ]);
}

export function createTailscaleSnapshot(run) {
  if (typeof run !== "function") {
    throw new TypeError("Tailscale snapshot runner is required.");
  }
  const commands = [
    ["version"],
    ["status", "--json"],
    ["switch", "--list"],
    ["serve", "status", "--json"]
  ];
  const results = commands.map((args) => {
    const result = run(Object.freeze([...args]));
    requireRecord(result, "Tailscale command result");
    requireExactKeys(
      result,
      ["status", "stderr", "stdout"],
      "Tailscale command result"
    );
    if (
      !Number.isSafeInteger(result.status) ||
      result.status < 0 ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) > 1_048_576 ||
      Buffer.byteLength(result.stderr) > 1_048_576
    ) {
      throw new TypeError("Tailscale command result is invalid.");
    }
    const normalizedStdout = normalizeTailscaleStdout(args, result.stdout);
    return {
      args: [...args],
      status: result.status,
      stdout_sha256: sha256(normalizedStdout),
      stderr_sha256: sha256(result.stderr)
    };
  });
  if (results[0]?.status !== 0 || results[1]?.status !== 0) {
    throw new TypeError("Tailscale prerequisite is not observable.");
  }
  return deepFreeze({
    schema_version: 1,
    commands: results,
    identity_sha256: sha256(canonicalJson(results))
  });
}

export function assertTailscaleSnapshotsEqual(before, after) {
  requireRecord(before, "Initial Tailscale snapshot");
  requireRecord(after, "Final Tailscale snapshot");
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error("Tailscale profile or Serve identity changed during acceptance.");
  }
}

export async function collectCleanupErrors(actions) {
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.length > 16 ||
    actions.some((action) => typeof action !== "function")
  ) {
    throw new TypeError("Cleanup actions are invalid.");
  }
  const errors = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return Object.freeze(errors);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoPrivateEvidence(candidate) {
  const finding = findPrivateEvidence(candidate, "$");
  if (finding === null) return;
  throw new TypeError(
    `Clean-user evidence contains private or host-specific data at ${finding.path} (${finding.category}).`
  );
}

function findPrivateEvidence(candidate, path) {
  if (typeof candidate === "string") {
    const lower = candidate.toLowerCase();
    if (
      ["auth.json", "device_token", "csrf_token", "nodekey:", "privatekey:"].some(
        (marker) => lower.includes(marker)
      )
    ) {
      return { category: "forbidden_marker", path };
    }
    if (candidate.includes("/home/")) return { category: "private_path", path };
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(candidate)) {
      return { category: "email", path };
    }
    if (/[A-Z0-9-]+\.ts\.net\b/iu.test(candidate)) {
      return { category: "tailnet_name", path };
    }
    return null;
  }
  if (Array.isArray(candidate)) {
    for (let index = 0; index < candidate.length; index += 1) {
      const finding = findPrivateEvidence(candidate[index], `${path}[${index}]`);
      if (finding !== null) return finding;
    }
    return null;
  }
  if (candidate === null || typeof candidate !== "object") return null;
  for (const [key, value] of Object.entries(candidate)) {
    const segment = /^[a-z][a-z0-9_]*$/u.test(key) ? key : "<dynamic>";
    const childPath = `${path}.${segment}`;
    const keyFinding = findPrivateEvidence(key, childPath);
    if (keyFinding !== null) return keyFinding;
    const finding = findPrivateEvidence(value, childPath);
    if (finding !== null) return finding;
  }
  return null;
}

function normalizeTailscaleStdout(args, stdout) {
  if (!sameArray(args, ["status", "--json"])) return stdout;
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new TypeError("Tailscale status output is not valid JSON.");
  }
  requireRecord(value, "Tailscale status output");
  const self = value.Self;
  const tailnet = value.CurrentTailnet;
  if (typeof value.BackendState !== "string") {
    throw new TypeError("Tailscale status backend state is invalid.");
  }
  if (self !== undefined) requireRecord(self, "Tailscale self status");
  if (tailnet !== undefined) requireRecord(tailnet, "Tailscale tailnet status");
  return canonicalJson({
    backend_state: value.BackendState,
    self:
      self === undefined
        ? null
        : {
            dns_name: typeof self.DNSName === "string" ? self.DNSName : null,
            host_name: typeof self.HostName === "string" ? self.HostName : null,
            id: typeof self.ID === "string" ? self.ID : null,
            tailscale_ips: Array.isArray(self.TailscaleIPs)
              ? self.TailscaleIPs.filter((item) => typeof item === "string").sort()
              : []
          },
    tailnet:
      tailnet === undefined
        ? null
        : {
            magic_dns_suffix:
              typeof tailnet.MagicDNSSuffix === "string"
                ? tailnet.MagicDNSSuffix
                : null,
            name: typeof tailnet.Name === "string" ? tailnet.Name : null
          }
  });
}

function requireHttpsUrl(value, hostname, label) {
  if (typeof value !== "string" || value.length > 512) {
    throw new TypeError(`${label} is invalid.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== hostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 1024 ||
    value.includes("\0") ||
    value.split("/").includes("..") ||
    value.includes("\n") ||
    value.includes(",")
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function requireExactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (!sameArray(keys, exact)) {
    throw new TypeError(`${label} fields are invalid.`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireBoundedString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\0") ||
    value.includes("\n")
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireVersionText(value, label) {
  requireBoundedString(value, label);
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireExactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    !sameArray(value, expected)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
