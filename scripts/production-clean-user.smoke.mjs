import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildProductionPackage } from "./build-production-package.mjs";
import {
  createTailscaleSnapshot,
  loadCleanEnvironmentManifest
} from "./clean-environment-contract.mjs";
import {
  assertProductionWebHttpSurface,
  loadProductionWebSmokeIdentity
} from "./production-web-smoke-support.mjs";
import { verifyProductionPackage } from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const manifest = loadCleanEnvironmentManifest();
const phase = parsePhase(process.argv.slice(2));
const criteriaCommit = requireCommit(
  process.env.HOSTDECK_CLEAN_CRITERIA_COMMIT,
  "criteria commit"
);
const sourceCommit = requireCommit(
  process.env.HOSTDECK_CLEAN_SOURCE_COMMIT,
  "source commit"
);
const evidenceRoot = manifest.container.evidence_dir;
const checkpointPath = join(evidenceRoot, "clean-user-checkpoint.json");
const evidencePath = join(evidenceRoot, "clean-user-evidence.json");
const cleanRoot = join(manifest.container.home, ".hostdeck-ifc-v1-058");
const packageRoot = join(cleanRoot, "packages");
const primaryPackage = join(packageRoot, "primary");
const upgradePackage = join(packageRoot, "upgrade");
const unrelatedRoot = join(cleanRoot, "unrelated");
const unrelatedSentinel = join(unrelatedRoot, "sentinel");
const unrelatedUnitName = "ifc-v1-058-unrelated-failure.service";
const unrelatedUnitPath = join(
  manifest.container.home,
  ".config",
  "systemd",
  "user",
  unrelatedUnitName
);
const configHome = join(manifest.container.home, ".config");
const dataHome = join(manifest.container.home, ".local", "share");
const stateHome = join(manifest.container.home, ".local", "state");
const stateDir = join(stateHome, "hostdeck-clean");
const databasePath = join(stateDir, "hostdeck.sqlite");
const stateSentinel = join(stateDir, "ifc-v1-058-sentinel");
const configSentinel = join(configHome, "hostdeck-clean-sentinel");
const codexHome = join(stateHome, "codex-clean");
const codexSentinel = join(codexHome, "ifc-v1-058-sentinel");
const installDataRoot = join(dataHome, "hostdeck");
const codexPackageRoot = join(
  manifest.container.home,
  ".local",
  "codex"
);
const codexBin = realpathSync(
  join(codexPackageRoot, "node_modules", "@openai", "codex", "bin", "codex.js")
);
const runtimeRoot = join(manifest.container.runtime_dir, "hostdeck");
const socketPath = join(runtimeRoot, "app-server.sock");
const shellProfilePaths = [".bash_logout", ".bashrc", ".profile"].map((name) =>
  join(manifest.container.home, name)
);
const userEnvironment = createProductEnvironment();

if (process.env.HOSTDECK_REQUIRE_CLEAN_USER_ACCEPTANCE !== "1") {
  throw new Error("Clean-user acceptance was not explicitly enabled.");
}

if (phase === "unavailable") {
  await runUnavailablePhase();
} else {
  await runObservedPhase();
}

async function runUnavailablePhase() {
  assertUnavailablePreflight();
  const phaseStarted = performance.now();
  const sentinels = createPreservationFixtures();
  const cleanSource = inspectCleanSource();
  const toolchain = inspectToolchain();
  const packages = await buildAndRelocatePackages();
  const port = await availableLoopbackPort();
  const foreground = await runForegroundAcceptance(port, packages.primary);
  const service = await runInitialServiceAcceptance(port, packages.primary);
  assertPreservationIdentity(sentinels);
  const checkpoint = {
    schema_version: 1,
    criteria_commit: criteriaCommit,
    source_commit: sourceCommit,
    port,
    clean_source: cleanSource,
    toolchain,
    packages,
    foreground,
    service,
    sentinels,
    unrelated_failed_units: listFailedUnits(),
    unavailable_phase_ms: roundedDuration(phaseStarted)
  };
  writeBoundedJson(checkpointPath, checkpoint);
  console.log(
    "HostDeck clean-user unavailable phase passed: fresh build, foreground/service parity, local readiness without Tailscale, independent restarts, idempotence, and active checkpoint."
  );
}

async function runObservedPhase() {
  const phaseStarted = performance.now();
  const checkpoint = readCheckpoint();
  assertPreservationIdentity(checkpoint.sentinels);
  assert.deepEqual(listFailedUnits(), checkpoint.unrelated_failed_units);
  assert.equal(existsSync(socketPath), true);
  const observedTailscale = snapshotContainerTailscale();
  const observed = await runObservedServiceAcceptance(
    checkpoint.port,
    checkpoint.packages,
    checkpoint.service
  );
  assertPreservationIdentity(checkpoint.sentinels);
  assert.deepEqual(listFailedUnits(), checkpoint.unrelated_failed_units);
  cleanupUnrelatedFixture();
  assertFinalProductCleanup(checkpoint.port);

  const evidence = {
    schema_version: 1,
    task_id: manifest.task_id,
    criteria_commit: criteriaCommit,
    source_commit: sourceCommit,
    host: {},
    container: {},
    toolchain: checkpoint.toolchain,
    clean_source: checkpoint.clean_source,
    packages: checkpoint.packages,
    foreground: checkpoint.foreground,
    service: {
      ...checkpoint.service,
      ...observed,
      unavailable_phase_ms: checkpoint.unavailable_phase_ms,
      observed_phase_ms: roundedDuration(phaseStarted)
    },
    tailscale: {
      client_version: manifest.tailscale.version,
      initial_daemon_unavailable: true,
      observed_identity_sha256: observedTailscale.identity_sha256,
      observation_only: true,
      profile_switch_calls: 0,
      serve_mutation_calls: 0
    },
    cleanup: {
      complete: false,
      installed_command_absent: true,
      lifecycle_coordination_retained: true,
      product_complete: true,
      processes_absent: true,
      runtime_absent: true,
      units_not_found: true
    },
    limits: {
      independent_kernel_or_vm: false,
      phone_tested: false,
      release_ready: false,
      shared_kernel: true
    }
  };
  writeBoundedJson(evidencePath, evidence);
  unlinkSync(checkpointPath);
  console.log(
    "HostDeck clean-user observed phase passed: Tailscale observation noninterference, active upgrade/retention, active and repeated uninstall, preservation, and zero product residue."
  );
}

function assertUnavailablePreflight() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.getuid?.(), manifest.container.uid);
  assert.equal(process.getgid?.(), manifest.container.gid);
  assert.deepEqual(process.getgroups?.(), [manifest.container.gid]);
  assert.equal(homedir(), manifest.container.home);
  const homeStats = lstatSync(manifest.container.home);
  assert.equal(homeStats.uid, manifest.container.uid);
  assert.equal(homeStats.gid, manifest.container.gid);
  assert.equal(homeStats.mode & 0o077, 0);
  assert.equal(realpathSync(repositoryRoot), manifest.container.checkout);
  assert.equal(readFileSync("/proc/1/comm", "utf8").trim(), "systemd");
  assert.equal(existsSync("/sys/fs/cgroup/cgroup.controllers"), true);
  assertZeroCapabilities(process.pid);
  assert.equal(
    runCommand("systemctl", ["--user", "is-system-running"]).stdout.trim(),
    "running"
  );
  assert.equal(existsSync("/run/tailscale/tailscaled.sock"), false);
  assert.deepEqual(readdirSync("/source"), ["HostDeck.bundle"]);
  assert.equal(existsSync("/source/node_modules"), false);
  assert.equal(existsSync("/source/dist"), false);
  assert.equal(existsSync("/usr/bin/sudo"), false);
  const tailscale = runCommand("/usr/bin/tailscale", ["status", "--json"], {
    statuses: [1]
  });
  assert.equal(tailscale.status, 1);
  assert.equal(existsSync(cleanRoot), false);
  assert.equal(existsSync(stateDir), false);
  assert.equal(existsSync(checkpointPath), false);
  assert.equal(existsSync(evidencePath), false);
  assertNoSystemInstallation();
  assertNoInstalledProduct();
  assertNoHostDeckProcesses();
}

function inspectCleanSource() {
  const head = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot
  }).stdout.trim();
  assert.equal(head, sourceCommit);
  assert.equal(
    runCommand(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=no"],
      { cwd: repositoryRoot }
    ).stdout,
    ""
  );
  const lockfile = readFileSync(
    join(repositoryRoot, manifest.contracts.source_lockfile)
  );
  assert.equal(existsSync(join(repositoryRoot, "node_modules")), true);
  assert.equal(existsSync(join(repositoryRoot, "dist")), false);
  return Object.freeze({
    commit: head,
    dist_preexisting: false,
    frozen_install: true,
    git_tracked_clean: true,
    host_build_output_mounted: false,
    host_dependency_tree_mounted: false,
    lockfile_sha256: hash(lockfile),
    node_modules_preexisting: false
  });
}

function inspectToolchain() {
  assertVersion(runCommand(process.execPath, ["--version"]).stdout, `v${manifest.node.version}`);
  assertVersion(runCommand("pnpm", ["--version"]).stdout, manifest.pnpm_version);
  const corepackVersion = runCommand("corepack", ["--version"]).stdout.trim();
  const npmVersion = runCommand("npm", ["--version"]).stdout.trim();
  const gitVersion = runCommand("git", ["--version"]).stdout.trim();
  const systemdVersion = runCommand("systemctl", ["--version"])
    .stdout.split("\n")[0]
    ?.trim();
  assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(corepackVersion));
  assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(npmVersion));
  assert.match(gitVersion, /^git version \d+\.\d+\.\d+/u);
  assert.match(systemdVersion ?? "", /^systemd 255\b/u);
  assertVersion(runCommand(codexBin, ["--version"]).stdout, `codex-cli ${manifest.codex.version}`);
  assertVersion(runCommand("/usr/bin/tailscale", ["version"]).stdout, manifest.tailscale.version, true);
  const packageLock = JSON.parse(
    readFileSync(join(codexPackageRoot, "package-lock.json"), "utf8")
  );
  const codexPackage = packageLock.packages?.["node_modules/@openai/codex"];
  assert.equal(codexPackage?.version, manifest.codex.version);
  assert.equal(codexPackage?.integrity, manifest.codex.integrity);
  return Object.freeze({
    codex: manifest.codex.version,
    codex_integrity_verified: true,
    corepack: corepackVersion,
    git: gitVersion.replace(/^git version /u, ""),
    native_modules_loaded: requireNativeModules(),
    node: manifest.node.version,
    npm: npmVersion,
    pnpm: manifest.pnpm_version,
    systemd: systemdVersion,
    tailscale: manifest.tailscale.version
  });
}

async function buildAndRelocatePackages() {
  const [primaryVersion, upgradeVersion] = manifest.package_versions;
  const primaryOutput = join(repositoryRoot, "dist", "hostdeck-clean-primary");
  const repeatedOutput = join(
    repositoryRoot,
    "dist",
    "hostdeck-clean-primary-repeat"
  );
  const upgradeOutput = join(repositoryRoot, "dist", "hostdeck-clean-upgrade");
  const primaryStarted = performance.now();
  const primary = buildProductionPackage({
    outputRoot: primaryOutput,
    packageVersion: primaryVersion,
    repositoryRoot
  });
  const primaryMs = roundedDuration(primaryStarted);
  const repeated = buildProductionPackage({
    outputRoot: repeatedOutput,
    packageVersion: primaryVersion,
    repositoryRoot
  });
  assert.deepEqual(repeated, primary);
  assert.equal(
    readFileSync(join(repeatedOutput, "hostdeck-package.json"), "utf8"),
    readFileSync(join(primaryOutput, "hostdeck-package.json"), "utf8")
  );
  const upgradeStarted = performance.now();
  const upgrade = buildProductionPackage({
    outputRoot: upgradeOutput,
    packageVersion: upgradeVersion,
    repositoryRoot
  });
  const upgradeMs = roundedDuration(upgradeStarted);
  const primaryVerification = verifyProductionPackage(primaryOutput);
  const repeatedVerification = verifyProductionPackage(repeatedOutput);
  const upgradeVerification = verifyProductionPackage(upgradeOutput);
  assert.deepEqual(primaryVerification, repeatedVerification);
  for (const root of [primaryPackage, upgradePackage]) {
    assert.equal(existsSync(root), false);
  }
  mkdirSync(packageRoot, { mode: 0o700, recursive: true });
  copyPackage(primaryOutput, primaryPackage);
  copyPackage(upgradeOutput, upgradePackage);
  makeReadOnly(primaryPackage);
  makeReadOnly(upgradePackage);
  runCommand(process.execPath, [
    join(primaryPackage, "verify.mjs"),
    primaryPackage
  ], { cwd: unrelatedRoot });
  runCommand(process.execPath, [
    join(upgradePackage, "verify.mjs"),
    upgradePackage
  ], { cwd: unrelatedRoot });
  const primaryManifest = readPackageManifest(primaryPackage);
  const upgradeManifest = readPackageManifest(upgradePackage);
  assert.deepEqual(primaryManifest.deferrals, []);
  assert.deepEqual(upgradeManifest.deferrals, []);
  makeWritable(repeatedOutput);
  rmSync(repeatedOutput, { force: true, recursive: true });
  return Object.freeze({
    deterministic_primary: true,
    primary: packageEvidence(primary, primaryVerification, primaryManifest, primaryMs),
    upgrade: packageEvidence(upgrade, upgradeVerification, upgradeManifest, upgradeMs)
  });
}

async function runForegroundAcceptance(port, packageEvidenceValue) {
  const started = performance.now();
  const packageManifest = readPackageManifest(primaryPackage);
  assert.equal(packageManifest.contentSha256, packageEvidenceValue.content_sha256);
  const command = packageCommand(primaryPackage, packageManifest);
  const child = spawn(
    command,
    [...baseArguments(port), "serve"],
    {
      cwd: unrelatedRoot,
      env: userEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const output = observeChild(child);
  try {
    await output.waitFor(
      `HostDeck foreground service ready at http://127.0.0.1:${port}.\n`,
      manifest.bounds.readiness_ms
    );
    const http = await inspectHttpSurface(port, primaryPackage, packageManifest);
    assert.equal(http.remote_ready, false);
    const processes = inspectForegroundProcesses(child.pid, command, port);
    assertPrivateSocket();
    assertLoopbackListener(port);
    child.kill("SIGTERM");
    const exit = await output.exited(manifest.bounds.readiness_ms);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    await eventually(
      () => !isProcessAlive(child.pid) && !existsSync(runtimeRoot),
      manifest.bounds.readiness_ms,
      "Foreground cleanup did not settle."
    );
    assertNoListener(port);
    assertNoHostDeckProcesses();
    return Object.freeze({
      duration_ms: roundedDuration(started),
      local_ready: true,
      package_version: packageManifest.packageVersion,
      processes,
      remote_unavailable: true,
      socket_mode: "0600",
      tcp_listener: "127.0.0.1",
      web_manifest_sha256: packageManifest.web.manifestSha256,
      web_sha256: packageManifest.web.sha256,
      http
    });
  } catch (error) {
    if (isProcessAlive(child.pid)) child.kill("SIGTERM");
    await output.exited(manifest.bounds.readiness_ms).catch(() => undefined);
    throw error;
  }
}

async function runInitialServiceAcceptance(port, packageEvidenceValue) {
  const started = performance.now();
  const primaryManifest = readPackageManifest(primaryPackage);
  const command = packageCommand(primaryPackage, primaryManifest);
  assertInvalidLifecycleOrdering(command, port);
  const installed = runLifecycle(command, port, "install");
  assertLifecycle(installed, {
    action: "install",
    api_state: "not_probed",
    changed: true,
    install_state: "coherent",
    package_version: packageEvidenceValue.package_version
  });
  assertUnitsInactive();
  const repeatedInstall = runLifecycle(command, port, "install");
  assert.equal(repeatedInstall.changed, false);
  const installedState = await loadInstalledState(primaryPackage);
  const layout = installedState.layout;
  assertInstalledInventory(layout, primaryManifest, installedState.owner);

  const startedResult = runLifecycle(command, port, "start");
  assert.equal(startedResult.api_state, "ready");
  const firstHostDeckPid = startedResult.units.hostdeck.main_pid;
  const firstCodexPid = startedResult.units.codex.main_pid;
  const firstSocket = socketIdentity();
  const firstHttp = await inspectHttpSurface(port, primaryPackage, primaryManifest);
  assert.equal(firstHttp.remote_ready, false);
  assert.equal(firstHttp.web_identity_sha256, packageEvidenceValue.web_sha256);
  const unitInventory = inspectServiceProcesses(
    startedResult,
    port,
    layout,
    installedState.owner
  );

  const repeatedStart = runLifecycle(command, port, "start");
  assert.equal(repeatedStart.changed, false);
  assert.equal(repeatedStart.units.hostdeck.main_pid, firstHostDeckPid);
  assert.equal(repeatedStart.units.codex.main_pid, firstCodexPid);

  const restarted = runLifecycle(command, port, "restart");
  assert.equal(restarted.api_state, "ready");
  assert.notEqual(restarted.units.hostdeck.main_pid, firstHostDeckPid);
  assert.equal(restarted.units.codex.main_pid, firstCodexPid);
  assert.equal(socketIdentity(), firstSocket);
  const hostDeckAfterRestart = restarted.units.hostdeck.main_pid;

  runSystemctl(["stop", "hostdeck-codex.service"]);
  const degraded = await waitForLifecycleStatus(command, port, "not_ready");
  assert.equal(degraded.units.hostdeck.main_pid, hostDeckAfterRestart);
  assert.equal(degraded.units.codex.main_pid, 0);
  assert.equal(existsSync(socketPath), false);
  runSystemctl(["start", "hostdeck-codex.service"]);
  const firstRecovery = await waitForLifecycleStatus(command, port, "ready");
  assert.equal(firstRecovery.units.hostdeck.main_pid, hostDeckAfterRestart);
  assert.notEqual(firstRecovery.units.codex.main_pid, firstCodexPid);
  const recoveredSocket = socketIdentity();
  assert.notEqual(recoveredSocket, firstSocket);

  runSystemctl(["restart", "hostdeck-codex.service"]);
  const recovered = await waitForLifecycleStatus(command, port, "ready");
  assert.equal(recovered.units.hostdeck.main_pid, hostDeckAfterRestart);
  assert.notEqual(recovered.units.codex.main_pid, firstRecovery.units.codex.main_pid);
  assert.notEqual(socketIdentity(), recoveredSocket);
  const codexAfterRestart = recovered.units.codex.main_pid;
  const socketAfterRestart = socketIdentity();

  const stopped = runLifecycle(command, port, "stop");
  assert.equal(stopped.units.hostdeck.main_pid, 0);
  assert.equal(stopped.units.codex.main_pid, 0);
  const repeatedStop = runLifecycle(command, port, "stop");
  assert.equal(repeatedStop.changed, false);
  const activeAgain = runLifecycle(command, port, "start");
  assert.equal(activeAgain.api_state, "ready");
  assertPreservationFixtures();
  assert.deepEqual(listFailedUnits(), [unrelatedUnitName]);
  assert.deepEqual(primaryManifest.deferrals, []);

  return Object.freeze({
    active_checkpoint: true,
    codex_pid_after_restart: codexAfterRestart,
    codex_pid_initial: firstCodexPid,
    codex_loss_reported_not_ready: true,
    codex_restart_changed_pid: codexAfterRestart !== firstCodexPid,
    duration_ms: roundedDuration(started),
    exact_install_inventory: true,
    foreground_service_http_parity:
      firstHttp.web_identity_sha256 === packageEvidenceValue.web_sha256,
    hostdeck_pid_after_restart: hostDeckAfterRestart,
    hostdeck_pid_initial: firstHostDeckPid,
    hostdeck_restart_preserved_codex: true,
    idempotent_install_start_stop: true,
    install_initially_inactive: true,
    invalid_lifecycle_order_rejected: true,
    package_version: primaryManifest.packageVersion,
    root_install_absent: true,
    socket_changed_on_codex_restart: socketAfterRestart !== firstSocket,
    socket_preserved_on_hostdeck_restart: true,
    unit_inventory: unitInventory,
    user_manager: "running"
  });
}

function assertInvalidLifecycleOrdering(command, port) {
  const result = runCommand(
    command,
    [...baseArguments(port), "service", "start", "--json"],
    { cwd: unrelatedRoot, env: userEnvironment, statuses: [1] }
  );
  assertPrivateOutput(result.stdout);
  assertPrivateOutput(result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /service is not installed/iu);
  assertNoInstalledProduct();
}

async function runObservedServiceAcceptance(port, packages, initialService) {
  assert.equal(initialService.active_checkpoint, true);
  assert.equal(initialService.package_version, packages.primary.package_version);
  const primaryManifest = readPackageManifest(primaryPackage);
  const primaryCommand = packageCommand(primaryPackage, primaryManifest);
  const beforeObservation = runLifecycle(primaryCommand, port, "status");
  assert.equal(beforeObservation.api_state, "ready");
  const codexBeforeObservation = beforeObservation.units.codex.main_pid;
  const socketBeforeObservation = socketIdentity();
  const observedRestart = runLifecycle(primaryCommand, port, "restart");
  assert.equal(observedRestart.api_state, "ready");
  assert.equal(observedRestart.units.codex.main_pid, codexBeforeObservation);
  assert.equal(socketIdentity(), socketBeforeObservation);

  const upgradeManifest = readPackageManifest(upgradePackage);
  const upgradeCommand = packageCommand(upgradePackage, upgradeManifest);
  const beforeUpgradeHostDeck = observedRestart.units.hostdeck.main_pid;
  const upgraded = runLifecycle(upgradeCommand, port, "upgrade");
  assertLifecycle(upgraded, {
    action: "upgrade",
    api_state: "ready",
    changed: true,
    install_state: "coherent",
    package_version: packages.upgrade.package_version
  });
  assert.notEqual(upgraded.units.hostdeck.main_pid, beforeUpgradeHostDeck);
  assert.equal(upgraded.units.codex.main_pid, codexBeforeObservation);
  assert.equal(socketIdentity(), socketBeforeObservation);
  const installedState = await loadInstalledState(upgradePackage);
  const layout = installedState.layout;
  assertInstalledInventory(layout, upgradeManifest, installedState.owner);
  assert.equal(readdirSync(layout.releases_dir).length, 2);
  const upgradedHttp = await inspectHttpSurface(port, upgradePackage, upgradeManifest);
  assert.equal(upgradedHttp.web_identity_sha256, packages.upgrade.web_sha256);
  assertPreservationFixtures();

  const humanStatus = runLifecycleText(upgradeCommand, port, "status");
  assert.match(humanStatus, /Installation: coherent/u);
  assert.match(humanStatus, /API readiness: ready/u);
  assertPrivateOutput(humanStatus);

  const installedCommand = realpathSync(layout.command_path);
  const activeUninstall = runLifecycle(layout.command_path, port, "uninstall");
  assertUninstall(activeUninstall, true);
  assert.equal(existsSync(installedCommand), false);
  assertUninstalledInventory(layout);
  const treeAfterUninstall = uninstalledTreeIdentity(layout);
  const repeatedUninstall = runLifecycle(upgradeCommand, port, "uninstall");
  assertUninstall(repeatedUninstall, false);
  assert.deepEqual(uninstalledTreeIdentity(layout), treeAfterUninstall);
  assertPreservationFixtures();
  assert.deepEqual(listFailedUnits(), [unrelatedUnitName]);
  return Object.freeze({
    active_upgrade: true,
    active_upgrade_hostdeck_restarted: true,
    active_upgrade_preserved_codex: true,
    active_upgrade_preserved_socket: true,
    installed_command_used_for_uninstall: true,
    observed_restart_preserved_codex: true,
    release_retention_count: 2,
    repeated_uninstall_unchanged: true,
    state_config_codex_preserved: true,
    tailscale_observation_restart_ready: true,
    uninstall_not_found_units: true,
    uninstall_product_residue: 0,
    upgrade_package_version: upgradeManifest.packageVersion,
    upgrade_web_sha256: upgradeManifest.web.sha256,
    upgraded_http: upgradedHttp
  });
}

function createPreservationFixtures() {
  for (const path of [
    cleanRoot,
    unrelatedRoot,
    configHome,
    stateDir,
    codexHome,
    dirname(unrelatedUnitPath)
  ]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  writeFileSync(unrelatedSentinel, "unrelated-sentinel\n", { mode: 0o600 });
  writeFileSync(stateSentinel, "state-sentinel\n", { mode: 0o600 });
  writeFileSync(configSentinel, "config-sentinel\n", { mode: 0o600 });
  writeFileSync(codexSentinel, "codex-sentinel\n", { mode: 0o600 });
  writeFileSync(
    unrelatedUnitPath,
    "[Unit]\nDescription=IFC-V1-058 unrelated failed-unit sentinel\n\n[Service]\nType=oneshot\nExecStart=/bin/false\n",
    { mode: 0o644 }
  );
  runSystemctl(["daemon-reload"]);
  runSystemctl(["start", unrelatedUnitName], { statuses: [1] });
  assert.deepEqual(listFailedUnits(), [unrelatedUnitName]);
  return preservationIdentity();
}

function cleanupUnrelatedFixture() {
  runSystemctl(["reset-failed", unrelatedUnitName]);
  unlinkSync(unrelatedUnitPath);
  runSystemctl(["daemon-reload"]);
  assert.deepEqual(listFailedUnits(), []);
}

function preservationIdentity() {
  return Object.freeze({
    codex: regularFileIdentity(codexSentinel),
    config: regularFileIdentity(configSentinel),
    state: regularFileIdentity(stateSentinel),
    shell_profiles: Object.fromEntries(
      shellProfilePaths.map((path) => [basename(path), optionalFileIdentity(path)])
    ),
    unrelated: regularFileIdentity(unrelatedSentinel),
    unrelated_unit: regularFileIdentity(unrelatedUnitPath)
  });
}

function optionalFileIdentity(path) {
  return existsNoFollow(path) ? regularFileIdentity(path) : null;
}

function assertPreservationIdentity(expected) {
  assert.deepEqual(preservationIdentity(), expected);
}

function assertPreservationFixtures() {
  for (const [path, content] of [
    [unrelatedSentinel, "unrelated-sentinel\n"],
    [stateSentinel, "state-sentinel\n"],
    [configSentinel, "config-sentinel\n"],
    [codexSentinel, "codex-sentinel\n"]
  ]) {
    assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(mode(path), 0o600);
  }
  assert.equal(existsSync(databasePath), true);
}

async function inspectHttpSurface(port, packagePath, packageManifest) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const webIdentity = loadProductionWebSmokeIdentity(packagePath);
  await assertProductionWebHttpSurface(baseUrl, webIdentity, boundedFetch);
  const live = await boundedFetch(`${baseUrl}/api/v1/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "alive" });
  const ready = await boundedFetch(`${baseUrl}/api/v1/health/ready`);
  assert.equal(ready.status, 200);
  const hostResponse = await boundedFetch(`${baseUrl}/api/v1/host/status`, {
    headers: { "x-hostdeck-local-admin": "cli-v1" }
  });
  assert.equal(hostResponse.status, 200);
  assert.equal(hostResponse.headers.get("cache-control"), "no-store");
  const host = await hostResponse.json();
  assert.equal(host.local.readiness, "ready");
  assert.equal(host.local.mutation_admission, "open");
  assert.equal(host.compatibility.state, "supported");
  assert.equal(host.compatibility.observed_version, manifest.codex.version);
  assert.equal(host.remote.availability === "ready", false);
  const index = await boundedFetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  const indexBytes = new Uint8Array(await index.arrayBuffer());
  assert(indexBytes.byteLength > 0);
  assert(indexBytes.byteLength <= manifest.bounds.http_body_bytes);
  assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  return Object.freeze({
    compatibility: "supported",
    index_sha256: hash(indexBytes),
    local_ready: true,
    no_store_status: true,
    package_version: packageManifest.packageVersion,
    remote_ready: false,
    security_headers: true,
    web_identity_sha256: packageManifest.web.sha256,
    web_manifest_sha256: packageManifest.web.manifestSha256
  });
}

function inspectForegroundProcesses(mainPid, command, port) {
  assert.equal(isProcessAlive(mainPid), true);
  assertProcessOwned(mainPid);
  const mainCommand = processCommand(mainPid);
  assert(mainCommand.includes(command));
  assert(mainCommand.includes("serve"));
  assert(mainCommand.includes(`--port=${port}`));
  const descendants = descendantPids(mainPid);
  assert(descendants.length >= 1);
  for (const pid of descendants) assertProcessOwned(pid);
  const appServerProcesses = descendants.filter((pid) => {
    const value = processCommand(pid).join(" ");
    return value.includes("app-server") && value.includes("unix://");
  });
  assert(appServerProcesses.length >= 1);
  return Object.freeze({
    app_server_launcher_trees: 1,
    app_server_processes: appServerProcesses.length,
    app_server_tree_processes: descendants.length,
    arguments_verified: true,
    hostdeck_main_pid: mainPid,
    hostdeck_main_processes: 1,
    uid: manifest.container.uid,
    zero_capabilities: true
  });
}

function inspectServiceProcesses(result, port, layout, owner) {
  const hostDeckPid = result.units.hostdeck.main_pid;
  const codexPid = result.units.codex.main_pid;
  assertProcessOwned(hostDeckPid);
  assertProcessOwned(codexPid);
  const hostDeckDescendants = descendantPids(hostDeckPid);
  const codexDescendants = descendantPids(codexPid);
  for (const pid of [...hostDeckDescendants, ...codexDescendants]) {
    assertProcessOwned(pid);
  }
  assert.equal(hostDeckDescendants.length, 0);
  assert(codexDescendants.length >= 1);
  const hostDeckCommand = processCommand(hostDeckPid);
  assert.deepEqual(hostDeckCommand, [
    owner.runtime.node_bin,
    join(owner.release.package_root, "dist", "service-host.js")
  ]);
  const codexCommands = [codexPid, ...codexDescendants].map((pid) =>
    processCommand(pid).join(" ")
  );
  assert(
    codexCommands.filter(
      (command) => command.includes("app-server") && command.includes("unix://")
    ).length >= 1
  );
  assert(
    codexCommands.some((command) =>
      command.includes(`unix://${socketPath}`)
    )
  );
  assert.equal(codexCommands.some((command) => /--listen\s+(?:tcp|http)/u.test(command)), false);
  const hostDeckUnit = assertUnitProcessIdentity(
    "hostdeck.service",
    hostDeckPid,
    layout.unit_paths["hostdeck.service"]
  );
  const codexUnit = assertUnitProcessIdentity(
    "hostdeck-codex.service",
    codexPid,
    layout.unit_paths["hostdeck-codex.service"]
  );
  for (const pid of codexDescendants) {
    assert.equal(processCgroup(pid), codexUnit.control_group);
  }
  assertPrivateSocket();
  assertLoopbackListener(port);
  return Object.freeze({
    codex_cgroup_processes: 1 + codexDescendants.length,
    codex_control_group: codexUnit.control_group,
    codex_main_pid: codexPid,
    hostdeck_cgroup_processes: 1,
    hostdeck_control_group: hostDeckUnit.control_group,
    hostdeck_main_pid: hostDeckPid,
    listener_count: 1,
    socket_owner_uid: manifest.container.uid,
    zero_capabilities: true
  });
}

function assertProcessOwned(pid) {
  const status = parseProcStatus(pid);
  assert.equal(status.Uid?.split(/\s+/u)[0], String(manifest.container.uid));
  assert.equal(status.Gid?.split(/\s+/u)[0], String(manifest.container.gid));
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
    assert.equal(status[field], "0000000000000000");
  }
}

function assertZeroCapabilities(pid) {
  assertProcessOwned(pid);
}

function parseProcStatus(pid) {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/status`, "utf8")
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index), line.slice(index + 1).trim()];
      })
  );
}

function processCommand(pid) {
  const command = readFileSync(`/proc/${pid}/cmdline`)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  assert(command.length > 0);
  return command;
}

function processCgroup(pid) {
  const entries = readFileSync(`/proc/${pid}/cgroup`, "utf8")
    .trim()
    .split("\n");
  assert.equal(entries.length, 1);
  const match = /^0::(.+)$/u.exec(entries[0]);
  assert(match?.[1] !== undefined);
  return match[1];
}

function assertUnitProcessIdentity(name, pid, fragmentPath) {
  const state = unitState(name);
  assert.equal(state.ActiveState, "active");
  assert.equal(state.SubState, "running");
  assert.equal(state.MainPID, String(pid));
  assert.equal(realpathSync(state.FragmentPath), realpathSync(fragmentPath));
  const controlGroup = processCgroup(pid);
  assert.equal(controlGroup, state.ControlGroup);
  assert(controlGroup.endsWith(`/app.slice/${name}`));
  return Object.freeze({ control_group: controlGroup });
}

function descendantPids(parentPid) {
  const parentByPid = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = parseProcStatus(Number(entry));
      const parent = Number(status.PPid);
      if (Number.isSafeInteger(parent)) parentByPid.set(Number(entry), parent);
    } catch {}
  }
  const descendants = [];
  const pending = [parentPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const [pid, candidateParent] of parentByPid) {
      if (candidateParent === parent && !descendants.includes(pid)) {
        descendants.push(pid);
        pending.push(pid);
      }
    }
  }
  return descendants.sort((left, right) => left - right);
}

function assertPrivateSocket() {
  const stats = lstatSync(socketPath);
  assert.equal(stats.isSocket(), true);
  assert.equal(stats.uid, manifest.container.uid);
  assert.equal(stats.gid, manifest.container.gid);
  assert.equal(stats.mode & 0o7777, 0o600);
  assert.equal(stats.nlink, 1);
}

function socketIdentity() {
  const stats = lstatSync(socketPath);
  return `${stats.dev}:${stats.ino}`;
}

function assertLoopbackListener(port) {
  const listeners = selectedTcpListeners(port);
  assert.deepEqual(listeners, [`127.0.0.1:${port}`]);
}

function assertNoListener(port) {
  assert.deepEqual(selectedTcpListeners(port), []);
}

function selectedTcpListeners(port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const listeners = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(path, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      const local = fields[1];
      const state = fields[3];
      if (state !== "0A" || local?.split(":")[1] !== portHex) continue;
      if (local === `0100007F:${portHex}`) listeners.push(`127.0.0.1:${port}`);
      else listeners.push(`unexpected:${local}`);
    }
  }
  return listeners.sort();
}

function runLifecycle(command, port, action) {
  const result = runCommand(
    command,
    [...baseArguments(port), "service", action, "--json"],
    { cwd: unrelatedRoot, env: userEnvironment, timeout: 180_000 }
  );
  assert.equal(result.stderr, "");
  assertPrivateOutput(result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, action);
  return parsed;
}

function runLifecycleText(command, port, action) {
  const result = runCommand(
    command,
    [...baseArguments(port), "service", action],
    { cwd: unrelatedRoot, env: userEnvironment, timeout: 180_000 }
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

async function waitForLifecycleStatus(command, port, expectedApiState) {
  let latest = null;
  await eventually(
    () => {
      try {
        latest = runLifecycle(command, port, "status");
        return latest.api_state === expectedApiState;
      } catch {
        return false;
      }
    },
    manifest.bounds.readiness_ms,
    "Service lifecycle status did not recover."
  );
  return latest;
}

function runSystemctl(args, options = {}) {
  return runCommand("systemctl", ["--user", "--no-pager", ...args], {
    env: userEnvironment,
    timeout: 120_000,
    ...options
  });
}

function listFailedUnits() {
  const result = runSystemctl([
    "list-units",
    "--failed",
    "--plain",
    "--no-legend",
    "--no-pager"
  ]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name) => name !== undefined && name !== "")
    .sort();
}

function assertUnitsInactive() {
  for (const name of ["hostdeck.service", "hostdeck-codex.service"]) {
    const state = unitState(name);
    assert.equal(state.ActiveState, "inactive");
    assert.equal(state.MainPID, "0");
  }
}

function unitState(name) {
  return Object.fromEntries(
    runSystemctl([
      "show",
      name,
      "--property=ActiveState,ControlGroup,FragmentPath,LoadState,MainPID,NeedDaemonReload,SubState,UnitFileState"
    ]).stdout
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

async function loadInstalledState(packagePath) {
  const module = await import(
    pathToFileURL(join(packagePath, "dist", "service-install-manifest.js")).href
  );
  const layout = module.resolveHostDeckServiceInstallLayout(userEnvironment);
  const owner = module.parseHostDeckServiceInstallManifest(
    readFileSync(layout.manifest_link, "utf8")
  );
  module.assertHostDeckServiceManifestMatchesLayout(owner, layout);
  return Object.freeze({ layout, owner });
}

function assertInstalledInventory(layout, packageManifest, owner) {
  assert.equal(owner.release.package_version, packageManifest.packageVersion);
  assert.equal(
    owner.release.package_content_sha256,
    packageManifest.contentSha256
  );
  assert.equal(
    owner.release.package_manifest_sha256,
    packageManifest.manifestSha256
  );
  assert.equal(owner.runtime.codex_bin, codexBin);
  assert.equal(owner.runtime.node_bin, process.execPath);
  assertOwnedLink(layout.current_link, owner.release.selector_target);
  assertOwnedLink(layout.manifest_link, owner.manifest_link.target);
  assertOwnedLink(layout.command_path, owner.command.target);
  assertOwnedLink(layout.enablement_link, owner.enablement.target);
  assert.equal(mode(layout.environment_file), 0o600);
  assert.equal(lstatSync(layout.environment_file).uid, manifest.container.uid);
  assert.equal(hash(readFileSync(layout.environment_file)), owner.environment.sha256);
  const releaseNames = readdirSync(layout.releases_dir).sort();
  assert(releaseNames.includes(owner.release.id));
  assert(releaseNames.length >= 1 && releaseNames.length <= 2);
  assert(
    releaseNames.every((name) =>
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{64}$/u.test(name)
    )
  );
  assertReleasePackageReadOnly(owner.release.package_root);
  assert.equal(existsNoFollow(layout.transaction_file), false);
  assert.equal(mode(layout.lifecycle_lock), 0o600);
  assert.equal(lstatSync(layout.lifecycle_lock).uid, manifest.container.uid);
  for (const unit of owner.units) {
    assertOwnedLink(unit.path, unit.target);
    const releaseUnit = join(owner.release.root, "units", unit.name);
    assert.equal(mode(releaseUnit), unit.mode);
    assert.equal(lstatSync(releaseUnit).uid, manifest.container.uid);
    assert.equal(hash(readFileSync(releaseUnit)), unit.sha256);
    const state = unitState(unit.name);
    assert.equal(realpathSync(state.FragmentPath), realpathSync(unit.path));
    assert.equal(
      state.UnitFileState,
      unit.name === "hostdeck.service" ? "enabled" : "linked"
    );
  }
  const enabled = runSystemctl(["is-enabled", "hostdeck.service"]);
  assert.equal(enabled.stdout.trim(), "enabled");
  assertNoSystemInstallation();
}

function assertOwnedLink(path, target) {
  const stats = lstatSync(path);
  assert.equal(stats.isSymbolicLink(), true);
  assert.equal(stats.uid, manifest.container.uid);
  assert.equal(stats.gid, manifest.container.gid);
  assert.equal(readlinkSync(path), target);
}

function assertReleasePackageReadOnly(root) {
  visit(root, (path, stats) => {
    assert.equal(stats.uid, manifest.container.uid, `Release owner: ${basename(path)}`);
    assert.equal(stats.gid, manifest.container.gid, `Release group: ${basename(path)}`);
    assert.equal(stats.mode & 0o222, 0, `Writable release path: ${basename(path)}`);
  });
}

function assertUninstall(actual, changed) {
  assertLifecycle(actual, {
    action: "uninstall",
    api_state: "not_probed",
    changed,
    enabled: false,
    install_state: "not_installed",
    package_version: null,
    release_id: null,
    rollback: "not_required"
  });
  for (const unit of [actual.units.hostdeck, actual.units.codex]) {
    assert.equal(unit.active_state, "inactive");
    assert.equal(unit.load_state, "not-found");
    assert.equal(unit.main_pid, 0);
    assert.equal(unit.need_daemon_reload, false);
  }
}

function assertUninstalledInventory(layout) {
  assert.deepEqual(readdirSync(layout.data_root), ["lifecycle.lock"]);
  assert.deepEqual(regularFileIdentity(layout.lifecycle_lock), {
    mode: 0o600,
    nlink: 1,
    sha256: hash(""),
    uid: manifest.container.uid
  });
  for (const path of [
    layout.command_path,
    layout.current_link,
    layout.manifest_link,
    layout.transaction_file,
    layout.releases_dir,
    layout.environment_file,
    layout.enablement_link,
    ...Object.values(layout.unit_paths)
  ]) {
    assert.equal(existsNoFollow(path), false, `Uninstall residue: ${basename(path)}`);
  }
  assert.equal(existsSync(runtimeRoot), false);
  assertNoHostDeckProcesses();
}

function uninstalledTreeIdentity(layout) {
  return Object.freeze({
    entries: readdirSync(layout.data_root),
    lock: regularFileIdentity(layout.lifecycle_lock)
  });
}

function assertFinalProductCleanup(port) {
  assertNoListener(port);
  assert.equal(existsSync(runtimeRoot), false);
  assertNoHostDeckProcesses();
  for (const name of ["hostdeck.service", "hostdeck-codex.service"]) {
    const state = unitState(name);
    assert.equal(state.LoadState, "not-found");
    assert.equal(state.ActiveState, "inactive");
    assert.equal(state.MainPID, "0");
    assert.equal(state.FragmentPath, "");
    assert.equal(state.NeedDaemonReload, "no");
  }
  assert.equal(existsSync(join(manifest.container.home, ".local", "bin", "codexdeck")), false);
  assertNoSystemInstallation();
}

function assertNoInstalledProduct() {
  for (const path of [
    installDataRoot,
    runtimeRoot,
    join(configHome, "systemd", "user", "hostdeck.service"),
    join(configHome, "systemd", "user", "hostdeck-codex.service"),
    join(manifest.container.home, ".local", "bin", "codexdeck")
  ]) {
    assert.equal(existsNoFollow(path), false);
  }
  for (const name of ["hostdeck.service", "hostdeck-codex.service"]) {
    const state = unitState(name);
    assert.equal(state.LoadState, "not-found");
    assert.equal(state.ActiveState, "inactive");
  }
}

function assertNoSystemInstallation() {
  for (const path of [
    "/etc/systemd/system/hostdeck.service",
    "/etc/systemd/system/hostdeck-codex.service",
    "/usr/lib/systemd/system/hostdeck.service",
    "/usr/lib/systemd/system/hostdeck-codex.service",
    "/usr/local/bin/codexdeck",
    "/usr/bin/codexdeck"
  ]) {
    assert.equal(existsNoFollow(path), false);
  }
}

function assertNoHostDeckProcesses() {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const commandLine = command.join(" ");
      if (
        commandLine.includes("service-host.js") ||
        (commandLine.includes("codex") && commandLine.includes("app-server"))
      ) {
        throw new Error("HostDeck product process remains after uninstall.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("product process")) {
        throw error;
      }
    }
  }
}

function snapshotContainerTailscale() {
  return createTailscaleSnapshot((args) => {
    const result = runCommand("/usr/bin/tailscale", args, { statuses: [0, 1] });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  });
}

function packageEvidence(build, verification, packageManifest, durationMs) {
  return Object.freeze({
    content_sha256: packageManifest.contentSha256,
    deferrals: [...packageManifest.deferrals],
    duration_ms: durationMs,
    entry_count: build.entryCount,
    manifest_sha256: packageManifest.manifestSha256,
    output_count: build.outputCount,
    package_version: packageManifest.packageVersion,
    source_count: build.sourceCount,
    verified_entry_count: verification.entryCount,
    web_file_count: build.webFileCount,
    web_manifest_sha256: packageManifest.web.manifestSha256,
    web_sha256: packageManifest.web.sha256
  });
}

function packageCommand(packagePath, packageManifest) {
  const command = join(packagePath, packageManifest.command.path);
  assert.equal(realpathSync(command), command);
  assert.equal(mode(command) & 0o111, 0o111);
  return command;
}

function readPackageManifest(packagePath) {
  const value = JSON.parse(
    readFileSync(join(packagePath, "hostdeck-package.json"), "utf8")
  );
  assert.equal(value.schemaVersion, manifest.contracts.package_manifest_schema);
  return value;
}

function copyPackage(source, destination) {
  cpSync(source, destination, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
}

function makeReadOnly(root) {
  const packageManifest = readPackageManifest(root);
  const executables = new Set(packageManifest.executableFiles);
  const directories = [];
  visit(root, (path, stats) => {
    if (stats.isDirectory()) directories.push(path);
    if (stats.isFile()) {
      const relativePath = relative(root, path).split(sep).join("/");
      chmodSync(path, executables.has(relativePath) ? 0o555 : 0o444);
    }
  });
  directories.sort((left, right) => right.length - left.length);
  for (const path of directories) chmodSync(path, 0o555);
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else if (stats.isFile()) {
    chmodSync(path, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

function visit(path, inspect) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  inspect(path, stats);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path)) visit(join(path, entry), inspect);
}

function baseArguments(port) {
  return [
    `--port=${port}`,
    "--state-dir",
    stateDir,
    "--database",
    databasePath
  ];
}

function createProductEnvironment() {
  return Object.freeze({
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: manifest.container.home,
    HOSTDECK_CODEX_BIN: codexBin,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: manifest.container.runtime_dir,
    XDG_STATE_HOME: stateHome
  });
}

function requireNativeModules() {
  const betterSqlite = realpathSync(
    join(repositoryRoot, "node_modules", "better-sqlite3")
  );
  const fsExt = realpathSync(join(repositoryRoot, "node_modules", "fs-ext"));
  const script =
    "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); require(process.argv[1]); require(process.argv[2]);";
  runCommand(process.execPath, ["--input-type=module", "--eval", script, betterSqlite, fsExt], {
    cwd: repositoryRoot
  });
  return true;
}

function observeChild(child) {
  let stdout = "";
  let stderr = "";
  let outputError = null;
  let exitResult = null;
  let exitResolve;
  const exitPromise = new Promise((resolveExit) => {
    exitResolve = resolveExit;
  });
  const append = (current, chunk) => {
    const next = `${current}${chunk.toString("utf8")}`;
    if (Buffer.byteLength(next) > manifest.bounds.command_output_bytes) {
      outputError = new Error("Clean foreground output exceeded its bound.");
      child.kill("SIGTERM");
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  child.once("error", (error) => {
    outputError = error;
  });
  child.once("exit", (code, signal) => {
    exitResult = { code, signal };
    exitResolve(exitResult);
  });
  return Object.freeze({
    async waitFor(expected, timeoutMs) {
      await eventually(
        () => {
          if (outputError !== null) throw outputError;
          if (exitResult !== null && !stdout.includes(expected)) {
            throw new Error(
              `Foreground exited before readiness (${exitResult.code}/${exitResult.signal}; ${boundedOutput(stderr)}).`
            );
          }
          return stdout.includes(expected);
        },
        timeoutMs,
        "Foreground did not report readiness."
      );
      assert.equal(stderr, "");
    },
    async exited(timeoutMs) {
      return await withTimeout(exitPromise, timeoutMs, "Foreground did not terminate.");
    }
  });
}

async function boundedFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000)
  });
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number(contentLength) > manifest.bounds.http_body_bytes
  ) {
    await response.body?.cancel();
    throw new Error("HTTP response exceeds clean-acceptance bound.");
  }
  if (response.body === null) return response;
  const chunks = [];
  const reader = response.body.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > manifest.bounds.http_body_bytes) {
      await reader.cancel();
      throw new Error("HTTP response exceeds clean-acceptance bound.");
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks, totalBytes), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error)
    )
  );
  return address.port;
}

function readCheckpoint() {
  const value = readBoundedJson(checkpointPath);
  assert.deepEqual(Object.keys(value).sort(), [
    "clean_source",
    "criteria_commit",
    "foreground",
    "packages",
    "port",
    "schema_version",
    "sentinels",
    "service",
    "source_commit",
    "toolchain",
    "unavailable_phase_ms",
    "unrelated_failed_units"
  ]);
  assert.equal(value.schema_version, 1);
  assert.equal(value.criteria_commit, criteriaCommit);
  assert.equal(value.source_commit, sourceCommit);
  assert(Number.isSafeInteger(value.port) && value.port >= 1024);
  return value;
}

function writeBoundedJson(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > manifest.bounds.command_output_bytes) {
    throw new Error("Clean-user evidence exceeds its byte bound.");
  }
  writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function readBoundedJson(path) {
  const stats = statSync(path);
  assert(stats.isFile());
  assert(stats.size > 0 && stats.size <= manifest.bounds.command_output_bytes);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: manifest.bounds.command_output_bytes,
    timeout: options.timeout ?? 120_000
  });
  if (result.error !== undefined) {
    throw new Error(`Clean-user command could not execute: ${basename(file)}.`);
  }
  const status = result.status ?? -1;
  const statuses = options.statuses ?? [0];
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!statuses.includes(status)) {
    throw new Error(
      `Clean-user command ${basename(file)} failed (${status}; ${boundedOutput(stderr)}).`
    );
  }
  return Object.freeze({ status, stderr, stdout });
}

function assertLifecycle(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `Lifecycle ${key} mismatch.`);
  }
}

function assertPrivateOutput(value) {
  assert.equal(
    [manifest.container.home, codexBin, repositoryRoot, "auth.json", "nodekey:"]
      .some((privateValue) => value.includes(privateValue)),
    false
  );
}

function regularFileIdentity(path) {
  const stats = lstatSync(path);
  assert.equal(stats.isFile(), true);
  return Object.freeze({
    mode: stats.mode & 0o7777,
    nlink: stats.nlink,
    sha256: hash(readFileSync(path)),
    uid: stats.uid
  });
}

function mode(path) {
  return lstatSync(path).mode & 0o7777;
}

function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertVersion(output, expected, prefixOnly = false) {
  const actual = output.trim();
  assert.equal(prefixOnly ? actual.startsWith(expected) : actual === expected, true);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundedDuration(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function boundedOutput(value) {
  return value
    .replaceAll(manifest.container.home, "<clean-home>")
    .replaceAll(repositoryRoot, "<checkout>")
    .trim()
    .slice(0, 1_000)
    .replace(/[\r\n]+/gu, " | ");
}

function parsePhase(args) {
  if (args.length !== 1 || !["--phase=unavailable", "--phase=observed"].includes(args[0])) {
    throw new TypeError("Clean-user acceptance phase is invalid.");
  }
  return args[0].slice("--phase=".length);
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError(`Clean-user ${label} is invalid.`);
  }
  return value;
}

async function eventually(check, timeoutMs, message) {
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, manifest.bounds.poll_ms));
  }
  throw new Error(message);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}
