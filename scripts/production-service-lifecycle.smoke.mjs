import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProductionPackage } from "./build-production-package.mjs";
import {
  productionPackageSourceCount,
  verifyProductionPackage
} from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const home = realpathSync(homedir());
const uid = process.getuid?.();
assert(Number.isSafeInteger(uid) && uid > 0);
const nodeBin = requireExecutable(process.execPath, "Node");
const codexBin = requireExactCodex(
  process.env.HOSTDECK_CODEX_BIN,
  "0.147.0"
);
const unitNames = ["hostdeck-codex.service", "hostdeck.service"];
const systemdUserRoot = join(home, ".config", "systemd", "user");
const hostDeckConfigRoot = join(home, ".config", "hostdeck");
const configPath = join(hostDeckConfigRoot, "config.json");
const environmentPath = join(hostDeckConfigRoot, "service.env");
const commandPath = join(home, ".local", "bin", "codexdeck");
const unitPaths = unitNames.map((name) => join(systemdUserRoot, name));
const enablementPath = join(
  systemdUserRoot,
  "default.target.wants",
  "hostdeck.service"
);
const runtimeRoot = `/run/user/${uid}/hostdeck`;
const smokeRoot = mkdtempSync(join(home, ".hostdeck-service-lifecycle-"));
chmodSync(smokeRoot, 0o700);
const dataHome = join(smokeRoot, "data-home");
const stateHome = join(smokeRoot, "state-home");
const stateDir = join(stateHome, "hostdeck");
const databasePath = join(stateDir, "hostdeck.sqlite");
const codexHome = join(smokeRoot, "codex-home");
const stateSentinelPath = join(stateDir, "lifecycle-sentinel");
const codexSentinelPath = join(codexHome, "lifecycle-sentinel");
const dataRoot = join(dataHome, "hostdeck");
const packageRoots = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map(
  (version) =>
    join(
      repositoryRoot,
      "dist",
      `hostdeck-lifecycle-${version.replaceAll(".", "-")}`
    )
);
const initialFailedUnits = listFailedUnits();
const initialTailscale = tailscaleIdentity();
let ownerManifest = null;
let primaryError = null;
let cleanupError = null;
let userSentinelsCreated = false;

try {
  assertCleanPreflight();
  for (const path of [hostDeckConfigRoot, stateDir, codexHome]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    chmodSync(path, 0o700);
  }
  writeFileSync(configPath, "config-sentinel\n", { mode: 0o600 });
  writeFileSync(stateSentinelPath, "state-sentinel\n", { mode: 0o600 });
  writeFileSync(codexSentinelPath, "codex-sentinel\n", { mode: 0o600 });
  userSentinelsCreated = true;
  assertPreservedUserState();

  const packages = packageRoots.map((outputRoot, index) => {
    const packageVersion = `${index + 1}.0.0`;
    rmSync(outputRoot, { force: true, recursive: true });
    buildProductionPackage({ outputRoot, packageVersion });
    const verification = verifyProductionPackage(outputRoot);
    assert.equal(verification.sourceCount, productionPackageSourceCount);
    return realpathSync(outputRoot);
  });
  const port = await availablePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const environment = lifecycleEnvironment();
  const baseArgs = [
    `--port=${port}`,
    "--state-dir",
    stateDir,
    "--database",
    databasePath
  ];

  const installed = runLifecycle(packages[0], baseArgs, environment, "install");
  assertLifecycle(installed, {
    action: "install",
    api_state: "not_probed",
    changed: true,
    install_state: "coherent",
    package_version: "1.0.0"
  });
  const installModule = await import(
    pathToFileURL(join(packages[0], "dist", "service-install-manifest.js")).href
  );
  const layout = installModule.resolveHostDeckServiceInstallLayout(environment);
  assert.equal(layout.data_root, dataRoot);
  ownerManifest = installModule.parseHostDeckServiceInstallManifest(
    readFileSync(join(dataRoot, "install.json"), "utf8")
  );
  installModule.assertHostDeckServiceManifestMatchesLayout(ownerManifest, layout);
  assertInstalledInventory(layout, ownerManifest);
  assertUnitsInactive();
  assertPreservedUserState();

  const selectorAfterInstall = readlinkSync(layout.current_link);
  const treeAfterInstall = ownedTreeIdentity(layout);
  const repeatedInstall = runLifecycle(
    packages[0],
    baseArgs,
    environment,
    "install"
  );
  assert.equal(repeatedInstall.changed, false);
  assert.equal(readlinkSync(layout.current_link), selectorAfterInstall);
  assert.deepEqual(ownedTreeIdentity(layout), treeAfterInstall);
  assertPreservedUserState();

  const started = runLifecycle(packages[0], baseArgs, environment, "start");
  assertLifecycle(started, {
    action: "start",
    api_state: "ready",
    changed: true,
    install_state: "coherent",
    package_version: "1.0.0"
  });
  const firstCodexPid = started.units.codex.main_pid;
  const firstHostDeckPid = started.units.hostdeck.main_pid;
  const firstSocket = socketIdentity();
  const repeatedStart = runLifecycle(
    packages[0],
    baseArgs,
    environment,
    "start"
  );
  assert.equal(repeatedStart.changed, false);
  assert.equal(repeatedStart.units.codex.main_pid, firstCodexPid);
  assert.equal(repeatedStart.units.hostdeck.main_pid, firstHostDeckPid);
  assertPreservedUserState();

  const humanStatus = runLifecycleText(
    packages[0],
    baseArgs,
    environment,
    "status"
  );
  assert.match(humanStatus, /Installation: coherent/u);
  assert.match(humanStatus, /API readiness: ready/u);
  assert.doesNotMatch(
    humanStatus,
    new RegExp(
      [escapeRegExp(home), escapeRegExp(smokeRoot), escapeRegExp(codexBin)].join(
        "|"
      ),
      "u"
    )
  );

  const restarted = runLifecycle(
    packages[0],
    baseArgs,
    environment,
    "restart"
  );
  assert.equal(restarted.api_state, "ready");
  assert.notEqual(restarted.units.hostdeck.main_pid, firstHostDeckPid);
  assert.equal(restarted.units.codex.main_pid, firstCodexPid);
  assert.equal(socketIdentity(), firstSocket);
  assertPreservedUserState();

  const stopped = runLifecycle(packages[0], baseArgs, environment, "stop");
  assert.equal(stopped.units.hostdeck.main_pid, 0);
  assert.equal(stopped.units.codex.main_pid, 0);
  const repeatedStop = runLifecycle(
    packages[0],
    baseArgs,
    environment,
    "stop"
  );
  assert.equal(repeatedStop.changed, false);
  assertPreservedUserState();
  const inactiveUpgrade = runLifecycle(
    packages[1],
    baseArgs,
    environment,
    "upgrade"
  );
  assertLifecycle(inactiveUpgrade, {
    action: "upgrade",
    api_state: "not_probed",
    changed: true,
    install_state: "coherent",
    package_version: "2.0.0"
  });
  assertPreservedUserState();
  assert.equal(readdirSync(layout.releases_dir).length, 2);

  const secondStarted = runLifecycle(
    packages[1],
    baseArgs,
    environment,
    "start"
  );
  const upgradeCodexPid = secondStarted.units.codex.main_pid;
  const upgradeHostDeckPid = secondStarted.units.hostdeck.main_pid;
  const upgradeSocket = socketIdentity();
  const activeUpgrade = runLifecycle(
    packages[2],
    baseArgs,
    environment,
    "upgrade"
  );
  assert.equal(activeUpgrade.package_version, "3.0.0");
  assert.equal(activeUpgrade.api_state, "ready");
  assert.equal(activeUpgrade.units.codex.main_pid, upgradeCodexPid);
  assert.notEqual(activeUpgrade.units.hostdeck.main_pid, upgradeHostDeckPid);
  assert.equal(socketIdentity(), upgradeSocket);
  assertPreservedUserState();
  const selectorBeforeRollback = readlinkSync(layout.current_link);

  const lifecycleModule = await import(
    pathToFileURL(join(packages[3], "dist", "service-lifecycle.js")).href
  );
  const managerModule = await import(
    pathToFileURL(join(packages[3], "dist", "systemd-user-manager.js")).href
  );
  const statusModule = await import(
    pathToFileURL(join(packages[3], "dist", "host-status-client.js")).href
  );
  const realManager = managerModule.createHostDeckSystemdUserManager();
  let restartCalls = 0;
  const injectedManager = Object.freeze({
    ...realManager,
    async restartHostDeck() {
      restartCalls += 1;
      if (restartCalls === 1) throw new Error("injected restart failure");
      await realManager.restartHostDeck();
    }
  });
  const statusClient = statusModule.createHostDeckHostStatusClient({ baseUrl });
  const rollbackLifecycle = lifecycleModule.createHostDeckServiceLifecycle({
    base_url: baseUrl,
    database_path: databasePath,
    env: environment,
    manager: injectedManager,
    node_bin: nodeBin,
    package_root: packages[3],
    read_host_status: async () => await statusClient.read(),
    readiness_timeout_ms: 90_000,
    state_dir: stateDir
  });
  const rollbackError = await capture(
    rollbackLifecycle.execute("upgrade")
  );
  assert(rollbackError instanceof lifecycleModule.HostDeckServiceLifecycleError);
  assert.equal(rollbackError.code, "lifecycle_failed");
  assert.equal(rollbackError.rollback, "succeeded");
  assert.equal(restartCalls, 2);
  assert.equal(readlinkSync(layout.current_link), selectorBeforeRollback);
  assert.equal(existsSync(layout.transaction_file), false);
  const afterRollback = runLifecycle(
    packages[2],
    baseArgs,
    environment,
    "status"
  );
  assert.equal(afterRollback.package_version, "3.0.0");
  assert.equal(afterRollback.api_state, "ready");
  assert.equal(afterRollback.units.codex.main_pid, upgradeCodexPid);
  assert.equal(socketIdentity(), upgradeSocket);
  assertPreservedUserState();
  assert.equal(readdirSync(layout.releases_dir).length, 3);
  assert.equal(
    readdirSync(layout.releases_dir).some((name) =>
      name.startsWith(".hostdeck-release-")
    ),
    false
  );

  const activeUninstall = runLifecycle(
    packages[3],
    baseArgs,
    environment,
    "uninstall"
  );
  assertUninstallResult(activeUninstall, true);
  assertUninstalledInventory(layout);
  assert.deepEqual(tailscaleIdentity(), initialTailscale);
  const treeAfterActiveUninstall = uninstalledTreeIdentity(layout);

  const repeatedUninstall = runLifecycle(
    packages[3],
    baseArgs,
    environment,
    "uninstall"
  );
  assertUninstallResult(repeatedUninstall, false);
  assert.deepEqual(uninstalledTreeIdentity(layout), treeAfterActiveUninstall);
  const uninstallText = runLifecycleText(
    packages[3],
    baseArgs,
    environment,
    "uninstall"
  );
  assert.match(uninstallText, /Installation: not_installed/u);
  assert.match(uninstallText, /Changed: no/u);
  assert.doesNotMatch(
    uninstallText,
    new RegExp(
      [escapeRegExp(home), escapeRegExp(smokeRoot), escapeRegExp(codexBin)].join(
        "|"
      ),
      "u"
    )
  );
  resetOwnedUnitRateLimits();

  const reinstalled = runLifecycle(
    packages[0],
    baseArgs,
    environment,
    "install"
  );
  assertLifecycle(reinstalled, {
    action: "install",
    api_state: "not_probed",
    changed: true,
    install_state: "coherent",
    package_version: "1.0.0"
  });
  const secondInactiveUpgrade = runLifecycle(
    packages[1],
    baseArgs,
    environment,
    "upgrade"
  );
  assert.equal(secondInactiveUpgrade.package_version, "2.0.0");
  assert.equal(secondInactiveUpgrade.api_state, "not_probed");
  const inactiveUninstall = runLifecycle(
    packages[1],
    baseArgs,
    environment,
    "uninstall"
  );
  assertUninstallResult(inactiveUninstall, true);
  assertUninstalledInventory(layout);
  resetOwnedUnitRateLimits();

  runLifecycle(packages[2], baseArgs, environment, "install");
  runLifecycle(packages[2], baseArgs, environment, "start");
  let disableCalls = 0;
  const uninstallFailureManager = Object.freeze({
    ...realManager,
    async disableHostDeck() {
      disableCalls += 1;
      if (disableCalls === 1) throw new Error("injected disable failure");
      await realManager.disableHostDeck();
    }
  });
  const uninstallFailureLifecycle = lifecycleModule.createHostDeckServiceLifecycle({
    base_url: baseUrl,
    database_path: databasePath,
    env: environment,
    manager: uninstallFailureManager,
    node_bin: nodeBin,
    package_root: packages[3],
    read_host_status: async () => await statusClient.read(),
    readiness_timeout_ms: 90_000,
    state_dir: stateDir
  });
  const uninstallError = await capture(
    uninstallFailureLifecycle.execute("uninstall")
  );
  assert(
    uninstallError instanceof lifecycleModule.HostDeckServiceLifecycleError
  );
  assert.equal(uninstallError.code, "uninstall_invalid");
  assert.equal(disableCalls, 1);
  assert.equal(
    JSON.parse(readFileSync(layout.transaction_file, "utf8")).phase,
    "stopped"
  );
  assertUnitsInactive();
  assertPreservedUserState();

  const recoveredUninstall = runLifecycle(
    packages[3],
    baseArgs,
    environment,
    "uninstall"
  );
  assertUninstallResult(recoveredUninstall, true);
  assertUninstalledInventory(layout);
  assert.deepEqual(tailscaleIdentity(), initialTailscale);
} catch (error) {
  primaryError = error;
} finally {
  try {
    cleanupOwnedState();
  } catch (error) {
    cleanupError = error;
  }
}

if (primaryError !== null && cleanupError !== null) {
  throw new AggregateError(
    [primaryError, cleanupError],
    "Service lifecycle smoke and cleanup both failed."
  );
}
if (primaryError !== null) throw primaryError;
if (cleanupError !== null) throw cleanupError;

assert.deepEqual(listFailedUnits(), initialFailedUnits);
assert.deepEqual(tailscaleIdentity(), initialTailscale);
assert.equal(existsSync(runtimeRoot), false);
console.log(
  "HostDeck persistent service lifecycle smoke passed: install/idempotence/start/status/restart/stop, inactive and active upgrades, rollback/retention, active/inactive/repeated/recovered uninstall, reinstall, stable Codex process/socket, private output, Tailscale noninterference, and zero owned residue."
);

function lifecycleEnvironment() {
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: home,
    HOSTDECK_CODEX_BIN: codexBin,
    PATH: process.env.PATH,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome
  };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_RUNTIME_DIR;
  assert(typeof env.PATH === "string" && env.PATH.length > 0);
  return Object.freeze(env);
}

function runLifecycle(packageRoot, baseArgs, env, action) {
  const result = runCommand(
    join(packageRoot, "dist", "shell.js"),
    [...baseArgs, "service", action, "--json"],
    { env, statuses: [0], timeout: 180_000 }
  );
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, action);
  assert.doesNotMatch(
    result.stdout,
    new RegExp(`${escapeRegExp(home)}|${escapeRegExp(codexBin)}`, "u")
  );
  return parsed;
}

function runLifecycleText(packageRoot, baseArgs, env, action) {
  const result = runCommand(
    join(packageRoot, "dist", "shell.js"),
    [...baseArgs, "service", action],
    { env, statuses: [0], timeout: 180_000 }
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

function assertLifecycle(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `Lifecycle ${key} mismatch.`);
  }
}

function assertUninstallResult(actual, changed) {
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
    sha256: sha256(""),
    uid
  });
  for (const path of [
    layout.current_link,
    layout.manifest_link,
    layout.transaction_file,
    layout.releases_dir,
    layout.environment_file,
    layout.command_path,
    layout.enablement_link,
    ...Object.values(layout.unit_paths)
  ]) {
    assert.equal(existsNoFollow(path), false, `Uninstall residue: ${path}`);
  }
  for (const name of unitNames) {
    const state = unitSnapshot(name);
    assert.equal(state.loadState, "not-found");
    assert.equal(state.activeState, "inactive");
    assert.equal(state.mainPid, 0);
  }
  assert.equal(existsSync(runtimeRoot), false);
  assertPreservedUserState();
}

function uninstalledTreeIdentity(layout) {
  return Object.freeze({
    entries: readdirSync(layout.data_root),
    lock: regularFileIdentity(layout.lifecycle_lock)
  });
}

function assertInstalledInventory(layout, manifest) {
  assert.equal(readlinkSync(layout.current_link), manifest.release.selector_target);
  assert.equal(readlinkSync(layout.manifest_link), manifest.manifest_link.target);
  assert.equal(readlinkSync(layout.command_path), manifest.command.target);
  assert.equal(readlinkSync(manifest.enablement.path), manifest.enablement.target);
  assert.equal(mode(layout.environment_file), 0o600);
  assert.equal(fileIdentity(layout.environment_file), manifest.environment.sha256);
  assert.equal(mode(join(manifest.release.root, "install.json")), 0o600);
  for (const unit of manifest.units) {
    assert.equal(readlinkSync(unit.path), unit.target);
    assert.equal(mode(join(manifest.release.root, "units", unit.name)), 0o644);
    assert.equal(fileIdentity(join(manifest.release.root, "units", unit.name)), unit.sha256);
  }
}

function assertUnitsInactive() {
  for (const name of unitNames) {
    const state = unitSnapshot(name);
    assert.equal(state.activeState, "inactive");
    assert.equal(state.mainPid, 0);
  }
}

function resetOwnedUnitRateLimits() {
  runSystemctl(["reset-failed", ...unitNames], [0, 1, 5]);
}

function unitSnapshot(name) {
  const result = runSystemctl([
    "show",
    name,
    "--property=LoadState",
    "--property=UnitFileState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--property=FragmentPath"
  ]);
  const values = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert(separator > 0);
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  return Object.freeze({
    activeState: values.ActiveState,
    fragmentPath: values.FragmentPath,
    loadState: values.LoadState,
    mainPid: Number(values.MainPID),
    subState: values.SubState,
    unitFileState: values.UnitFileState
  });
}

function assertCleanPreflight() {
  const homeMetadata = lstatSync(home);
  assert.equal(homeMetadata.uid, uid);
  assert.equal(homeMetadata.isDirectory(), true);
  assert.equal(homeMetadata.mode & 0o022, 0);
  for (const path of [
    dataRoot,
    hostDeckConfigRoot,
    commandPath,
    enablementPath,
    runtimeRoot,
    ...unitPaths
  ]) {
    assert.equal(
      existsNoFollow(path),
      false,
      `Service lifecycle smoke requires an absent path: ${path}`
    );
  }
  for (const name of unitNames) {
    const state = unitSnapshot(name);
    assert.equal(state.loadState, "not-found");
    assert.equal(state.mainPid, 0);
  }
}

function cleanupOwnedState() {
  const errors = [];
  if (userSentinelsCreated) {
    try {
      assertPreservedUserState();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const name of ["hostdeck.service", "hostdeck-codex.service"]) {
    try {
      runSystemctl(["stop", name], [0, 5]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    runSystemctl(["disable", "hostdeck.service"], [0, 1, 5]);
  } catch (error) {
    errors.push(error);
  }
  try {
    removeExactEnablementLink();
  } catch (error) {
    errors.push(error);
  }
  for (const [path, expectedTarget] of [
    [unitPaths[0], join(dataRoot, "current", "units", unitNames[0])],
    [unitPaths[1], join(dataRoot, "current", "units", unitNames[1])],
    [commandPath, join(dataRoot, "current", "package", "dist", "shell.js")]
  ]) {
    try {
      removeExactLink(path, expectedTarget);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    if (existsNoFollow(environmentPath)) {
      const metadata = lstatSync(environmentPath);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.uid, uid);
      assert.equal(metadata.nlink, 1);
      assert.equal(metadata.mode & 0o7777, 0o600);
      if (ownerManifest !== null) {
        assert.equal(fileIdentity(environmentPath), ownerManifest.environment.sha256);
      }
      unlinkSync(environmentPath);
    }
    if (existsNoFollow(configPath)) {
      assert.deepEqual(
        regularFileIdentity(configPath),
        expectedSentinelIdentity("config-sentinel\n")
      );
      unlinkSync(configPath);
    }
    if (existsNoFollow(hostDeckConfigRoot)) {
      assert.equal(readdirSync(hostDeckConfigRoot).length, 0);
      rmdirSync(hostDeckConfigRoot);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (existsNoFollow(dataRoot)) {
      assert.equal(relative(smokeRoot, dataRoot).startsWith(".."), false);
      rmSync(dataRoot, { force: false, recursive: true });
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    runSystemctl(["daemon-reload"]);
    const failed = listFailedUnits();
    for (const name of unitNames.filter(
      (name) => failed.includes(name) && !initialFailedUnits.includes(name)
    )) {
      runSystemctl(["reset-failed", name]);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (existsSync(runtimeRoot)) {
      throw new Error("HostDeck runtime directory remained after service stop.");
    }
    for (const name of unitNames) {
      assert.equal(unitSnapshot(name).loadState, "not-found");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    rmSync(smokeRoot, { force: true, recursive: true });
    for (const root of packageRoots) {
      rmSync(root, { force: true, recursive: true });
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Service lifecycle smoke cleanup failed.");
  }
}

function removeExactEnablementLink() {
  if (!existsNoFollow(enablementPath)) return;
  const metadata = lstatSync(enablementPath);
  assert.equal(metadata.isSymbolicLink(), true);
  assert.equal(metadata.uid, uid);
  const target = readlinkSync(enablementPath);
  const stableTarget = join(systemdUserRoot, "hostdeck.service");
  const releaseRelative = relative(join(dataRoot, "releases"), target);
  const releaseParts = releaseRelative.split("/");
  const directReleaseTarget =
    releaseParts.length === 3 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{64}$/u.test(
      releaseParts[0]
    ) &&
    releaseParts[1] === "units" &&
    releaseParts[2] === "hostdeck.service";
  assert.equal(target === stableTarget || directReleaseTarget, true);
  unlinkSync(enablementPath);
}

function removeExactLink(path, expectedTarget) {
  if (!existsNoFollow(path)) return;
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), true);
  assert.equal(metadata.uid, uid);
  assert.equal(readlinkSync(path), expectedTarget);
  unlinkSync(path);
}

function runSystemctl(args, statuses = [0]) {
  return runCommand(
    "/usr/bin/systemctl",
    ["--user", "--no-pager", ...args],
    { cwd: home, env: process.env, statuses, timeout: 120_000 }
  );
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? smokeRoot,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 128 * 1024,
    timeout: options.timeout
  });
  assert.equal(result.error, undefined, `${command} failed to execute.`);
  assert.equal(result.signal, null, `${command} was signaled.`);
  assert.equal(
    options.statuses.includes(result.status),
    true,
    `${command} exited ${result.status}: ${bounded(result.stderr)}`
  );
  return result;
}

function listFailedUnits() {
  const result = runSystemctl(
    ["--failed", "--plain", "--no-legend", "--no-pager"],
    [0]
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean)
    .sort();
}

function tailscaleIdentity() {
  const candidate = ["/usr/bin/tailscale", "/usr/local/bin/tailscale"].find(
    existsSync
  );
  if (candidate === undefined) return Object.freeze({ installed: false });
  const status = runCommand(candidate, ["status", "--json"], {
    cwd: home,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    statuses: [0],
    timeout: 10_000
  });
  const profiles = runCommand(candidate, ["switch", "--list"], {
    cwd: home,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    statuses: [0],
    timeout: 10_000
  });
  const serve = runCommand(candidate, ["serve", "status", "--json"], {
    cwd: home,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    statuses: [0],
    timeout: 10_000
  });
  const parsed = JSON.parse(status.stdout);
  return Object.freeze({
    backendState: parsed.BackendState ?? null,
    currentTailnet: parsed.CurrentTailnet?.Name ?? null,
    dnsName: parsed.Self?.DNSName ?? null,
    installed: true,
    profilesSha256: sha256(profiles.stdout),
    selfId: parsed.Self?.ID ?? null,
    serveSha256: sha256(serve.stdout)
  });
}

function assertPreservedUserState() {
  assert.deepEqual(
    regularFileIdentity(configPath),
    expectedSentinelIdentity("config-sentinel\n")
  );
  assert.deepEqual(
    regularFileIdentity(stateSentinelPath),
    expectedSentinelIdentity("state-sentinel\n")
  );
  assert.deepEqual(
    regularFileIdentity(codexSentinelPath),
    expectedSentinelIdentity("codex-sentinel\n")
  );
}

function regularFileIdentity(path) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  return Object.freeze({
    mode: metadata.mode & 0o7777,
    nlink: metadata.nlink,
    sha256: fileIdentity(path),
    uid: metadata.uid
  });
}

function expectedSentinelIdentity(content) {
  return Object.freeze({ mode: 0o600, nlink: 1, sha256: sha256(content), uid });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error)
    )
  );
  return port;
}

function socketIdentity() {
  const metadata = statSync(join(runtimeRoot, "app-server.sock"));
  assert.equal(metadata.isSocket(), true);
  return `${metadata.dev}:${metadata.ino}`;
}

function ownedTreeIdentity(layout) {
  return Object.freeze({
    command: readlinkSync(layout.command_path),
    environment: fileIdentity(layout.environment_file),
    releaseCount: readdirSync(layout.releases_dir).length,
    selector: readlinkSync(layout.current_link),
    units: Object.values(layout.unit_paths).map((path) => readlinkSync(path))
  });
}

function fileIdentity(path) {
  return sha256(readFileSync(path));
}

function mode(path) {
  return lstatSync(path).mode & 0o7777;
}

function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireExecutable(candidate, label) {
  assert(typeof candidate === "string" && candidate.startsWith("/"));
  const path = realpathSync(candidate);
  const metadata = lstatSync(path);
  assert.equal(path, candidate, `${label} must be canonical.`);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.mode & 0o022, 0);
  assert.notEqual(metadata.mode & 0o111, 0);
  return path;
}

function requireExactCodex(candidate, expectedVersion) {
  const path = requireExecutable(candidate, "Codex");
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `codex-cli ${expectedVersion}\n`);
  return path;
}

async function capture(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function bounded(value) {
  return String(value).replace(/[\r\n]+/gu, " ").slice(0, 500);
}
