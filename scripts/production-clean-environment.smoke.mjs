import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertTailscaleSnapshotsEqual,
  collectCleanupErrors,
  createCleanEnvironmentDockerfile,
  createCleanEnvironmentDockerRunArgs,
  createTailscaleSnapshot,
  loadCleanEnvironmentManifest,
  parseCleanGitStatus,
  parseCleanUserEvidence,
  parseDockerImageIdentity,
  redactCleanDiagnostic
} from "./clean-environment-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const criteriaCommit = "2aa21e98a68aeccaa5b5ac4d6f0a0aa654eed7a5";
const manifest = loadCleanEnvironmentManifest();
const outputRoot = join(
  repositoryRoot,
  "artifacts",
  "ifc-v1-058-clean-environment-parity"
);
const outputPath = join(outputRoot, "evidence.json");

export async function runCleanEnvironmentAcceptance() {
  if (process.env.HOSTDECK_REQUIRE_CLEAN_ENVIRONMENT_ACCEPTANCE !== "1") {
    throw new Error(
      "Clean-environment acceptance requires the explicit repository smoke command."
    );
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Clean-environment acceptance requires Linux x86-64.");
  }
  if (existsSync(outputPath)) {
    throw new Error("Clean-environment evidence already exists; refusing overwrite.");
  }

  const source = inspectSourceIdentity();
  inspectDockerHost();
  assertTaskResourcesAbsent(source.image_tag);
  const hostTailscaleBefore = snapshotHostTailscale();
  let evidenceRoot = null;
  let buildContext = null;
  let sourceRoot = null;
  let sourceBundle = null;
  let bootstrapIdentity = null;
  let containerStarted = false;
  let imageBuilt = false;
  let primaryError = null;
  let cleanupErrors = [];
  let hostIdentity = null;
  let containerIdentity = null;
  let userEvidence = null;
  let hostTailscaleAfter = null;

  try {
    evidenceRoot = mkdtempSync(
      join(tmpdir(), "hostdeck-ifc-v1-058-evidence-")
    );
    buildContext = mkdtempSync(
      join(tmpdir(), "hostdeck-ifc-v1-058-context-")
    );
    sourceRoot = mkdtempSync(
      join(tmpdir(), "hostdeck-ifc-v1-058-source-")
    );
    chmodSync(evidenceRoot, 0o700);
    chmodSync(buildContext, 0o700);
    chmodSync(sourceRoot, 0o755);
    sourceBundle = prepareSourceBundle(sourceRoot, source.source_commit);

    stage("pull pinned Ubuntu image");
    runCommand("docker", ["pull", manifest.base_image.reference], {
      timeout: manifest.bounds.image_build_ms
    });
    const baseImage = inspectDockerImage(manifest.base_image.reference);
    if (!baseImage.repo_digests.includes(`ubuntu@${manifest.base_image.digest}`)) {
      throw new Error("Pulled Ubuntu image digest is contradictory.");
    }

    stage("build clean prerequisite image");
    runCommand(
      "docker",
      [
        "build",
        "--quiet",
        "--no-cache",
        "--pull=false",
        "--tag",
        source.image_tag,
        "--file",
        "-",
        buildContext
      ],
      {
        input: createCleanEnvironmentDockerfile(manifest),
        timeout: manifest.bounds.image_build_ms
      }
    );
    imageBuilt = true;
    const builtImage = inspectDockerImage(source.image_tag);

    stage("start isolated systemd substrate");
    const run = runCommand(
      "docker",
      createCleanEnvironmentDockerRunArgs(manifest, {
        evidence_root: evidenceRoot,
        image_tag: source.image_tag,
        source_root: sourceRoot,
        tailscale_root: "/run/tailscale"
      })
    );
    containerStarted = true;
    if (!/^[0-9a-f]{64}$/u.test(run.stdout.trim())) {
      throw new Error("Docker returned an invalid clean-container identity.");
    }
    await waitForSystemManager();
    startUserManager();
    await waitForUserManager();
    const rootBootstrap = inspectRootBootstrap();

    const containerInspect = inspectDockerContainer();
    if (
      containerInspect.host_config.network_mode !== "bridge" ||
      containerInspect.host_config.pid_mode !== "" ||
      containerInspect.host_config.cgroupns_mode !== "private" ||
      containerInspect.host_config.privileged !== true
    ) {
      throw new Error("Clean container namespaces are invalid.");
    }
    assert.deepEqual(containerInspect.mounts, [
      { destination: "/evidence", read_only: false, type: "bind" },
      { destination: "/host-tailscale", read_only: true, type: "bind" },
      { destination: "/source", read_only: true, type: "bind" }
    ]);
    const systemdVersion = rootExec("systemctl", ["--version"]).stdout
      .split("\n")[0]
      ?.trim();
    if (!/^systemd 255\b/u.test(systemdVersion ?? "")) {
      throw new Error("Clean container systemd version is unsupported.");
    }

    stage("bootstrap exact ordinary-user toolchain");
    bootstrapIdentity = bootstrapCleanUser(source.source_commit);

    stage("run clean foreground and unavailable-service phase");
    userExec(nodeBin(), [
      join(manifest.container.checkout, "scripts", "production-clean-user.smoke.mjs"),
      "--phase=unavailable"
    ], {
      cwd: manifest.container.checkout,
      env: cleanUserEnvironment(source.source_commit),
      timeout: manifest.bounds.acceptance_ms
    });
    assertTailscaleSnapshotsEqual(hostTailscaleBefore, snapshotHostTailscale());

    stage("expose observation-only host Tailscale socket");
    rootExec("install", ["-d", "-m", "0755", "/run/tailscale"]);
    rootExec("ln", [
      "-s",
      `${manifest.container.tailscale_mount}/tailscaled.sock`,
      "/run/tailscale/tailscaled.sock"
    ]);

    stage("run observed-service upgrade and uninstall phase");
    userExec(nodeBin(), [
      join(manifest.container.checkout, "scripts", "production-clean-user.smoke.mjs"),
      "--phase=observed"
    ], {
      cwd: manifest.container.checkout,
      env: cleanUserEnvironment(source.source_commit),
      timeout: manifest.bounds.acceptance_ms
    });

    const rawEvidence = readBoundedJson(
      join(evidenceRoot, "clean-user-evidence.json"),
      manifest.bounds.command_output_bytes
    );
    hostTailscaleAfter = snapshotHostTailscale();
    assertTailscaleSnapshotsEqual(hostTailscaleBefore, hostTailscaleAfter);

    hostIdentity = inspectHostEvidence(source.excluded_png_count);
    containerIdentity = {
      architecture: manifest.base_image.architecture,
      base_digest: manifest.base_image.digest,
      cgroup_namespace: "private",
      image_id: builtImage.id,
      mounts: containerInspect.mounts,
      network_mode: "default_bridge",
      os: manifest.base_image.os,
      os_version: manifest.base_image.version,
      pid_namespace: "private",
      privileged_validation_infrastructure: true,
      root_bootstrap: rootBootstrap,
      system_manager: "running",
      systemd_version: systemdVersion,
      uid: manifest.container.uid,
      user_manager: "running"
    };
    userEvidence = {
      ...rawEvidence,
      host: hostIdentity,
      container: containerIdentity,
      clean_source: {
        ...rawEvidence.clean_source,
        bootstrap: bootstrapIdentity,
        source_bundle_bytes: sourceBundle.bytes,
        source_bundle_sha256: sourceBundle.sha256
      },
      tailscale: {
        ...rawEvidence.tailscale,
        host_after_sha256: hostTailscaleAfter.identity_sha256,
        host_before_sha256: hostTailscaleBefore.identity_sha256,
        host_identity_unchanged: true,
        raw_profile_data_recorded: false
      },
      cleanup: {
        ...rawEvidence.cleanup,
        product_complete: true,
        complete: true
      }
    };
    if (
      rawEvidence.tailscale.observed_identity_sha256 !==
      hostTailscaleBefore.identity_sha256
    ) {
      throw new Error("Container and host Tailscale observations are incoherent.");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupErrors = [
      ...(await collectCleanupErrors([
        async () => {
          if (!containerStarted) return;
          await stopContainer();
          containerStarted = false;
        },
        () => {
          if (!imageBuilt) return;
          removeImage(source.image_tag);
          imageBuilt = false;
        },
        () => {
          const finalTailscale = snapshotHostTailscale();
          assertTailscaleSnapshotsEqual(hostTailscaleBefore, finalTailscale);
          hostTailscaleAfter ??= finalTailscale;
        },
        ...[buildContext, evidenceRoot, sourceRoot]
          .filter((path) => path !== null)
          .map((path) => () => rmSync(path, { force: true, recursive: true })),
        () => assertTaskResourcesAbsent(source.image_tag)
      ]))
    ];
  }

  if (primaryError !== null || cleanupErrors.length > 0) {
    const errors = [
      ...(primaryError === null ? [] : [primaryError]),
      ...cleanupErrors
    ];
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(
          errors,
          "Clean-environment acceptance and cleanup both failed."
        );
  }

  const evidence = parseCleanUserEvidence(userEvidence, manifest, {
    criteria_commit: criteriaCommit,
    source_commit: source.source_commit
  });
  publishEvidence(evidence);
  console.log(
    `HostDeck clean-environment parity passed at ${source.source_commit.slice(0, 12)}: pinned Noble, fresh frozen install/build, foreground/service parity, independent restarts, Tailscale unavailable/observed noninterference, active upgrade/retention, active/repeated uninstall, and complete cleanup.`
  );
  return evidence;
}

function inspectSourceIdentity() {
  const sourceCommit = git(["rev-parse", "HEAD"]).stdout.trim();
  const originCommit = git(["rev-parse", "origin/main"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit) || sourceCommit !== originCommit) {
    throw new Error("Clean acceptance requires HEAD to equal origin/main.");
  }
  git(["merge-base", "--is-ancestor", criteriaCommit, sourceCommit]);
  const status = git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]).stdout;
  const statusIdentity = parseCleanGitStatus(status);
  const gitlinks = git(["ls-files", "--stage"]).stdout
    .split("\n")
    .filter((line) => line.startsWith("160000 "));
  if (gitlinks.length > 0 || existsSync(join(repositoryRoot, ".gitmodules"))) {
    throw new Error("Clean acceptance does not support submodule inputs.");
  }
  const lfs = git([
    "grep",
    "-l",
    "^version https://git-lfs.github.com/spec/v1$",
    sourceCommit,
    "--"
  ], { statuses: [0, 1] });
  if (lfs.status === 0 && lfs.stdout.trim() !== "") {
    throw new Error("Clean acceptance does not support Git LFS inputs.");
  }
  return Object.freeze({
    excluded_png_count: statusIdentity.excluded_png_count,
    image_tag: `${manifest.container.image_tag_prefix}:${sourceCommit.slice(0, 12)}`,
    source_commit: sourceCommit
  });
}

function inspectDockerHost() {
  const info = JSON.parse(
    runCommand("docker", ["info", "--format", "{{json .}}"])
      .stdout
  );
  if (
    info.OSType !== "linux" ||
    info.Architecture !== "x86_64" ||
    info.CgroupVersion !== "2" ||
    info.CgroupDriver !== "systemd"
  ) {
    throw new Error("Docker host lacks the selected Linux/systemd/cgroup-v2 contract.");
  }
}

function inspectDockerImage(reference) {
  const raw = runCommand("docker", ["image", "inspect", reference]).stdout;
  return parseDockerImageIdentity(raw);
}

function inspectDockerContainer() {
  const raw = runCommand("docker", [
    "container",
    "inspect",
    manifest.container.name
  ]).stdout;
  const values = JSON.parse(raw);
  const value = Array.isArray(values) && values.length === 1 ? values[0] : null;
  if (
    value?.State?.Running !== true ||
    typeof value.HostConfig !== "object" ||
    !Array.isArray(value.Mounts)
  ) {
    throw new Error("Clean container inspection is invalid.");
  }
  const mounts = value.Mounts.map((mount) => ({
    destination: mount.Destination,
    read_only: mount.RW === false,
    type: mount.Type
  })).sort((left, right) => left.destination.localeCompare(right.destination));
  return Object.freeze({
    host_config: Object.freeze({
      cgroupns_mode: value.HostConfig.CgroupnsMode,
      network_mode: value.HostConfig.NetworkMode,
      pid_mode: value.HostConfig.PidMode,
      privileged: value.HostConfig.Privileged
    }),
    mounts: Object.freeze(mounts.map((mount) => Object.freeze(mount)))
  });
}

function inspectHostEvidence(excludedPngCount) {
  const osRelease = Object.fromEntries(
    readFileSync("/etc/os-release", "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/gu, "")];
      })
  );
  const dockerVersion = runCommand("docker", [
    "version",
    "--format",
    "{{.Server.Version}}"
  ]).stdout.trim();
  return Object.freeze({
    architecture: process.arch,
    docker_server_version: dockerVersion,
    excluded_uncommitted_png_count: excludedPngCount,
    kernel_shared: true,
    os: osRelease.ID,
    os_version: osRelease.VERSION_ID
  });
}

function inspectRootBootstrap() {
  const uid = rootExec("id", ["-u", manifest.container.user]).stdout.trim();
  const gid = rootExec("id", ["-g", manifest.container.user]).stdout.trim();
  assert.equal(uid, String(manifest.container.uid));
  assert.equal(gid, String(manifest.container.gid));
  const tailscaleVersion = rootExec("dpkg-query", [
    "-W",
    `-f=\${Version}`,
    "tailscale"
  ]).stdout.trim();
  assert.equal(tailscaleVersion, manifest.tailscale.version);
  const archiveHash = rootExec("sha256sum", [
    "/opt/hostdeck-bootstrap/node.tar.xz"
  ]).stdout.trim();
  assert(archiveHash.startsWith(`${manifest.node.archive_sha256}  `));
  const enabled = rootExec("systemctl", ["is-enabled", "tailscaled.service"], {
    statuses: [1]
  });
  assert.equal(enabled.stdout.trim(), "disabled");
  const active = rootExec("systemctl", ["is-active", "tailscaled.service"], {
    statuses: [3]
  });
  assert.equal(active.stdout.trim(), "inactive");
  const cgroup = rootExec("test", ["-f", "/sys/fs/cgroup/cgroup.controllers"]);
  assert.equal(cgroup.status, 0);
  return Object.freeze({
    actions: Object.freeze([
      "install_os_prerequisites",
      "verify_node_archive",
      "install_tailscale_client",
      "disable_tailscale_daemon",
      "start_uid_1000_manager"
    ]),
    node_archive_sha256: manifest.node.archive_sha256,
    product_lifecycle_actions: 0,
    tailscale_daemon: "disabled_inactive",
    tailscale_package_version: tailscaleVersion,
    uid: manifest.container.uid
  });
}

function bootstrapCleanUser(sourceCommit) {
  const home = manifest.container.home;
  const localNode = join(home, ".local", "node");
  const localCodex = join(home, ".local", "codex");
  const started = performance.now();
  userExec("install", ["-d", "-m", "0700", localNode], {
    label: "create ordinary-user toolchain root"
  });
  const nodeStarted = performance.now();
  userExec("tar", [
    "-xJf",
    "/opt/hostdeck-bootstrap/node.tar.xz",
    "-C",
    localNode,
    "--strip-components=1"
  ], { label: "extract pinned Node archive" });
  const nodeExtractMs = elapsed(nodeStarted);
  const corepackStarted = performance.now();
  const corepackEnable = userExec(nodeBin("corepack"), ["enable"], {
    label: "enable Corepack"
  });
  const corepackPrepare = userExec(nodeBin("corepack"), [
    "prepare",
    `pnpm@${manifest.pnpm_version}`,
    "--activate"
  ], { label: "activate pinned pnpm" });
  assertNoBootstrapWarning(corepackEnable, "Corepack enable");
  assertNoBootstrapWarning(corepackPrepare, "Corepack prepare");
  const corepackMs = elapsed(corepackStarted);
  const codexStarted = performance.now();
  const codexInstall = userExec(nodeBin("npm"), [
    "install",
    "--prefix",
    localCodex,
    "--package-lock=true",
    "--save-exact",
    "--no-audit",
    "--no-fund",
    `${manifest.codex.package}@${manifest.codex.version}`
  ], {
    label: "install pinned Codex",
    timeout: manifest.bounds.bootstrap_ms
  });
  assertNoBootstrapWarning(codexInstall, "Codex install");
  const codexInstallMs = elapsed(codexStarted);
  const cloneStarted = performance.now();
  userExec("git", [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--no-tags",
    "/source/HostDeck.bundle",
    manifest.container.checkout
  ], {
    label: "clone committed source bundle",
    timeout: manifest.bounds.bootstrap_ms
  });
  userExec("git", [
    "-C",
    manifest.container.checkout,
    "checkout",
    "--detach",
    sourceCommit
  ], { label: "detach exact source commit" });
  const actualCommit = userExec("git", [
    "-C",
    manifest.container.checkout,
    "rev-parse",
    "HEAD"
  ], { label: "inspect cloned source commit" }).stdout.trim();
  assert.equal(actualCommit, sourceCommit);
  for (const path of ["node_modules", "dist"]) {
    const absent = userExec("test", [
      "!",
      "-e",
      join(manifest.container.checkout, path)
    ], { label: "inspect clean checkout inputs", statuses: [0, 1] });
    if (absent.status !== 0) {
      throw new Error(`Clean checkout unexpectedly contains ${path}.`);
    }
  }
  const cloneMs = elapsed(cloneStarted);
  const installStarted = performance.now();
  const frozenInstall = userExec(nodeBin("pnpm"), [
    "install",
    "--frozen-lockfile",
    "--reporter=append-only"
  ], {
    cwd: manifest.container.checkout,
    label: "install frozen dependency graph",
    timeout: manifest.bounds.bootstrap_ms
  });
  assertNoBootstrapWarning(frozenInstall, "Frozen install");
  const frozenInstallMs = elapsed(installStarted);
  const dirty = userExec("git", [
    "-C",
    manifest.container.checkout,
    "status",
    "--porcelain=v1",
    "--untracked-files=no"
  ], { label: "inspect frozen-install source state" }).stdout;
  if (dirty !== "") {
    throw new Error("Frozen install changed tracked clean-checkout bytes.");
  }
  const contractTestStarted = performance.now();
  userExec(nodeBin(), [
    "--test",
    join(
      manifest.container.checkout,
      "scripts",
      "clean-environment-contract.test.mjs"
    )
  ], {
    cwd: manifest.container.checkout,
    label: "run clean-environment contract tests"
  });
  return Object.freeze({
    codex_install_ms: codexInstallMs,
    corepack_ms: corepackMs,
    direct_contract_test_ms: elapsed(contractTestStarted),
    frozen_install_ms: frozenInstallMs,
    install_warning_count: 0,
    node_extract_ms: nodeExtractMs,
    source_clone_ms: cloneMs,
    total_ms: elapsed(started)
  });
}

function assertNoBootstrapWarning(result, label) {
  if (result.stderr !== "" || /\bwarn(?:ing)?\b/iu.test(result.stdout)) {
    throw new Error(`${label} emitted an unsupported warning.`);
  }
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function prepareSourceBundle(sourceRoot, sourceCommit) {
  const path = join(sourceRoot, "HostDeck.bundle");
  git(["bundle", "create", path, "HEAD"]);
  git(["bundle", "verify", path]);
  const heads = git(["bundle", "list-heads", path]).stdout.trim();
  if (heads !== `${sourceCommit} HEAD`) {
    throw new Error("Clean source bundle identity is contradictory.");
  }
  chmodSync(path, 0o444);
  const bytes = statSync(path).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 536_870_912) {
    throw new Error("Clean source bundle size is invalid.");
  }
  const sha256Output = runCommand("sha256sum", [path]).stdout.trim();
  const match = /^([0-9a-f]{64}) {2}/u.exec(sha256Output);
  if (match?.[1] === undefined) {
    throw new Error("Clean source bundle hash is invalid.");
  }
  return Object.freeze({ bytes, sha256: match[1] });
}

async function waitForSystemManager() {
  await eventually(async () => {
    const result = rootExec("systemctl", ["is-system-running"], {
      statuses: [0, 1]
    });
    return result.stdout.trim() === "running";
  }, manifest.bounds.readiness_ms, "Container system manager did not become ready.");
}

function startUserManager() {
  rootExec("loginctl", ["enable-linger", manifest.container.user]);
  rootExec("systemctl", ["start", `user@${manifest.container.uid}.service`]);
}

async function waitForUserManager() {
  await eventually(async () => {
    const result = userExec("systemctl", ["--user", "is-system-running"], {
      statuses: [0, 1]
    });
    return result.stdout.trim() === "running";
  }, manifest.bounds.readiness_ms, "Container user manager did not become ready.");
}

async function stopContainer() {
  const errors = [];
  let graceful = false;
  try {
    const stop = runCommand("docker", [
      "stop",
      "--timeout",
      String(manifest.bounds.container_stop_seconds),
      manifest.container.name
    ], { statuses: [0, 1], timeout: manifest.bounds.host_command_ms });
    if (stop.status !== 0) {
      throw new Error("Clean container could not be stopped gracefully.");
    }
    graceful = true;
  } catch (error) {
    errors.push(error);
  }
  try {
    await eventually(
      () => !containerExists(),
      manifest.bounds.readiness_ms,
      "Clean container removal did not settle."
    );
  } catch (error) {
    errors.push(error);
  }
  if (containerExists()) {
    try {
      runCommand(
        "docker",
        ["container", "rm", "--force", manifest.container.name],
        { statuses: [0, 1] }
      );
      await eventually(
        () => !containerExists(),
        manifest.bounds.readiness_ms,
        "Forced clean-container removal did not settle."
      );
    } catch (error) {
      errors.push(error);
    }
    if (containerExists()) {
      errors.push(new Error("Clean container remains after forced cleanup."));
    }
  }
  if (!graceful || errors.length > 0) {
    throw new AggregateError(errors, "Clean container cleanup was not graceful.");
  }
}

function containerExists() {
  return runCommand(
    "docker",
    ["container", "inspect", manifest.container.name],
    { statuses: [0, 1] }
  ).status === 0;
}

function removeImage(imageTag) {
  const errors = [];
  try {
    runCommand("docker", ["image", "rm", imageTag]);
  } catch (error) {
    errors.push(error);
  }
  let inspect = runCommand("docker", ["image", "inspect", imageTag], {
    statuses: [0, 1]
  });
  if (inspect.status === 0) {
    try {
      runCommand("docker", ["image", "rm", "--force", imageTag]);
    } catch (error) {
      errors.push(error);
    }
    inspect = runCommand("docker", ["image", "inspect", imageTag], {
      statuses: [0, 1]
    });
    if (inspect.status === 0) {
      errors.push(new Error("Clean acceptance image remains after forced cleanup."));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Clean image cleanup was not graceful.");
  }
}

function assertTaskResourcesAbsent(imageTag) {
  const container = runCommand("docker", [
    "container",
    "inspect",
    manifest.container.name
  ], { statuses: [0, 1] });
  if (container.status === 0) {
    throw new Error("A prior clean-acceptance container still exists.");
  }
  const image = runCommand("docker", ["image", "inspect", imageTag], {
    statuses: [0, 1]
  });
  if (image.status === 0) {
    throw new Error("A prior clean-acceptance image tag still exists.");
  }
}

function snapshotHostTailscale() {
  return createTailscaleSnapshot((args) => {
    const result = runCommand("/usr/bin/tailscale", args, {
      exposeOutput: false,
      statuses: [0, 1]
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  });
}

function publishEvidence(evidence) {
  mkdirSync(outputRoot, { mode: 0o755, recursive: true });
  const staging = join(outputRoot, ".evidence.json.pending");
  writeFileSync(staging, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644
  });
  renameSync(staging, outputPath);
}

function readBoundedJson(path, maximumBytes) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error("Clean-user evidence file is invalid.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanUserEnvironment(sourceCommit) {
  const home = manifest.container.home;
  return Object.freeze({
    CI: "1",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${manifest.container.runtime_dir}/bus`,
    HOME: home,
    HOSTDECK_CLEAN_CRITERIA_COMMIT: criteriaCommit,
    HOSTDECK_CLEAN_SOURCE_COMMIT: sourceCommit,
    HOSTDECK_REQUIRE_CLEAN_USER_ACCEPTANCE: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: manifest.container.user,
    PATH: `${join(home, ".local", "node", "bin")}:${join(home, ".local", "codex", "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    USER: manifest.container.user,
    XDG_RUNTIME_DIR: manifest.container.runtime_dir
  });
}

function nodeBin(name = "node") {
  return join(manifest.container.home, ".local", "node", "bin", name);
}

function rootExec(file, args, options = {}) {
  return runCommand("docker", [
    "exec",
    manifest.container.name,
    file,
    ...args
  ], options);
}

function userExec(file, args, options = {}) {
  const environment = {
    ...cleanUserEnvironment(
      options.env?.HOSTDECK_CLEAN_SOURCE_COMMIT ?? "0".repeat(40)
    ),
    ...(options.env ?? {})
  };
  const dockerArgs = [
    "exec",
    "--user",
    `${manifest.container.uid}:${manifest.container.gid}`,
    ...(options.cwd === undefined ? [] : ["--workdir", options.cwd])
  ];
  for (const [name, value] of Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    dockerArgs.push("--env", `${name}=${value}`);
  }
  dockerArgs.push(manifest.container.name, file, ...args);
  const { cwd: _containerCwd, env: _containerEnv, ...hostOptions } = options;
  return runCommand("docker", dockerArgs, hostOptions);
}

function git(args, options = {}) {
  return runCommand("git", args, { ...options, cwd: repositoryRoot });
}

function runCommand(file, args, options = {}) {
  if (typeof file !== "string" || !Array.isArray(args)) {
    throw new TypeError("Bounded command input is invalid.");
  }
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.hostEnv ?? process.env,
    input: options.input,
    maxBuffer: manifest.bounds.command_output_bytes,
    timeout: options.timeout ?? manifest.bounds.host_command_ms
  });
  if (result.error !== undefined) {
    const code =
      typeof result.error.code === "string" ? result.error.code : "unknown";
    const detail = boundedDiagnostic(result.stdout ?? "", result.stderr ?? "");
    throw new Error(
      `Bounded command failed to execute: ${options.label ?? file} (${code}; ${detail}).`
    );
  }
  const status = result.status ?? -1;
  const statuses = options.statuses ?? [0];
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!statuses.includes(status)) {
    const detail = options.exposeOutput === false
      ? "output redacted"
      : boundedDiagnostic(stdout, stderr);
    throw new Error(`Bounded command ${file} failed (${status}; ${detail}).`);
  }
  return Object.freeze({ status, stderr, stdout });
}

function boundedDiagnostic(stdout, stderr) {
  return redactCleanDiagnostic(stdout, stderr, [
    repositoryRoot,
    manifest.container.home
  ]);
}

async function eventually(check, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, manifest.bounds.poll_ms)
    );
  }
  throw new Error(message);
}

function stage(label) {
  console.log(`[IFC-V1-058] ${label}`);
}

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCleanEnvironmentAcceptance().catch((error) => {
    const message = formatFailure(error);
    console.error(`HostDeck clean-environment parity failed: ${message}`);
    process.exitCode = 1;
  });
}

function formatFailure(error) {
  const pending = [error];
  const messages = [];
  while (pending.length > 0 && messages.length < 16) {
    const current = pending.shift();
    if (current instanceof AggregateError) {
      messages.push(current.message);
      pending.unshift(...current.errors);
      continue;
    }
    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause !== undefined) pending.push(current.cause);
      continue;
    }
    messages.push(String(current));
  }
  return redactCleanDiagnostic(messages.join("\n"), "", [
    repositoryRoot,
    manifest.container.home
  ]);
}
