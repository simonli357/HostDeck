import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertProductionWebHttpSurface,
  loadProductionWebSmokeIdentity
} from "./production-web-smoke-support.mjs";
import { verifyProductionPackage } from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const sourcePackage = realpathSync(join(repositoryRoot, "dist", "hostdeck"));
const verification = verifyProductionPackage(sourcePackage);
const sourceManifest = JSON.parse(
  readFileSync(join(sourcePackage, "hostdeck-package.json"), "utf8")
);
const codexBin = requireExactCodexBinary(
  process.env.HOSTDECK_CODEX_BIN,
  sourceManifest.codex.codexVersion
);
const uid = requireCurrentUid();
const managerRuntimeHome = requireRuntimeHome(uid);
const managerUnitRoot = join(managerRuntimeHome, "systemd", "user");
const canonicalUnitNames = ["hostdeck-codex.service", "hostdeck.service"];
const unitPrefix = `hostdeck-package-smoke-${process.pid}`;
const brokerUnitName = `${unitPrefix}-codex.service`;
const hostDeckUnitName = `${unitPrefix}.service`;
const unitNames = [brokerUnitName, hostDeckUnitName];
const root = mkdtempSync(join(homedir(), ".hostdeck-systemd-units-"));
const packageRoot = join(root, "package");
const homeDir = join(root, "home");
const configHome = join(root, "config-home");
const stateHome = join(root, "state-home");
const foregroundRuntimeHome = join(root, "runtime-home");
const runtimeDir = join(managerRuntimeHome, unitPrefix);
const stateDir = join(stateHome, "hostdeck");
const databasePath = join(stateDir, "hostdeck.sqlite");
const leasePath = join(stateDir, "hostdeck.lock");
const codexHome = join(root, "codex-home");
const controlDir = join(codexHome, "app-server-control");
const socketPath = join(controlDir, "app-server-control.sock");
const ownerPath = join(controlDir, "hostdeck-broker-owner.json");
const commandDir = join(root, "bin");
const environmentRoot = join(root, "environment");
const environmentFile = join(environmentRoot, "hostdeck.env");
const generatedUnitRoot = join(root, "units");
const bundledNode = join(packageRoot, sourceManifest.runtime.bundle.path);
const linkedUnitPaths = unitNames.map((name) => join(managerUnitRoot, name));
const initialRuntimeIdentity = pathIdentityOrNull(runtimeDir);
let unitsLinked = false;
let cleanupError = null;
let primaryError = null;
let initialFailedUnits = [];
let initialTailscaleIdentity = null;

try {
  initialFailedUnits = listFailedUserUnits();
  initialTailscaleIdentity = observeTailscaleIdentity();
  assertCleanPreflight();

  cpSync(sourcePackage, packageRoot, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
  chmodSync(packageRoot, 0o755);
  normalizePackageModes(packageRoot, new Set(sourceManifest.executableFiles));
  requireCanonicalExecutable(bundledNode, "Bundled Node");
  const webIdentity = loadProductionWebSmokeIdentity(packageRoot);
  for (const path of [
    homeDir,
    configHome,
    stateHome,
    foregroundRuntimeHome,
    codexHome,
    commandDir,
    environmentRoot,
    generatedUnitRoot
  ]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    chmodSync(path, 0o700);
  }
  writeFileSync(
    join(codexHome, "config.toml"),
    "check_for_update_on_startup = false\n[features]\nplugins = false\n",
    { mode: 0o600 }
  );
  symlinkSync(bundledNode, join(commandDir, "node"));
  const port = await availableLoopbackPort();
  writeEnvironmentFile(port);

  const generatorModule = await import(
    pathToFileURL(join(packageRoot, "dist", "systemd-user-units.js")).href
  );
  const bundle = generatorModule.generateHostDeckSystemdUserUnits({
    codex_bin: codexBin,
    environment_file: environmentFile,
    expected_package_version: sourceManifest.packageVersion,
    node_bin: bundledNode,
    package_root: packageRoot
  });
  generatorModule.assertHostDeckSystemdUserUnitBundle(bundle);
  assert.equal(bundle.schema_version, 2);
  assert.equal(bundle.broker_host_path, join(packageRoot, sourceManifest.brokerHost.path));
  assert.equal(bundle.service_host_path, join(packageRoot, sourceManifest.serviceHost.path));
  assert.deepEqual(
    bundle.units.map((unit) => unit.name),
    canonicalUnitNames
  );
  const generatedUnitPaths = bundle.units.map((unit) => {
    assert.equal(unit.mode, 0o644);
    assert.equal(sha256(unit.content), unit.sha256);
    const isolated = isolateGeneratedUnit(unit);
    const path = join(generatedUnitRoot, isolated.name);
    writeFileSync(path, isolated.content, { mode: unit.mode });
    chmodSync(path, unit.mode);
    return path;
  });
  verifyGeneratedUnits(generatedUnitPaths);
  makeReadOnly(packageRoot, new Set(sourceManifest.executableFiles));
  runSystemctl(["--runtime", "link", ...generatedUnitPaths]);
  unitsLinked = true;
  runSystemctl(["daemon-reload"]);
  assertLinkedUnits(generatedUnitPaths);

  runSystemctl(["start", hostDeckUnitName]);
  await waitForUnitsReady(port, webIdentity);
  let codex = await requireActiveUnit(brokerUnitName);
  let hostDeck = await requireActiveUnit(hostDeckUnitName);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);
  assertUnprivilegedProcess(codex.mainPid);
  assertUnprivilegedProcess(hostDeck.mainPid);
  await assertStandardBroker();
  assertLoopbackOnlyListener(port);
  const firstSocketIdentity = socketIdentity();
  const firstBrokerIdentity = brokerIdentity();
  const firstCodexPid = codex.mainPid;
  const firstHostDeckPid = hostDeck.mainPid;

  runSystemctl(["start", hostDeckUnitName]);
  codex = await requireActiveUnit(brokerUnitName);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(codex.mainPid, firstCodexPid);
  assert.equal(hostDeck.mainPid, firstHostDeckPid);
  assert.equal(socketIdentity(), firstSocketIdentity);
  assert.equal(brokerIdentity(), firstBrokerIdentity);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);

  runSystemctl(["restart", hostDeckUnitName]);
  hostDeck = await waitForDifferentMainPid(hostDeckUnitName, firstHostDeckPid);
  codex = await requireActiveUnit(brokerUnitName);
  assert.equal(codex.mainPid, firstCodexPid);
  assert.equal(socketIdentity(), firstSocketIdentity);
  assert.equal(brokerIdentity(), firstBrokerIdentity);
  await eventuallyReady(port, 30_000);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);
  const secondHostDeckPid = hostDeck.mainPid;

  runSystemctl(["restart", brokerUnitName]);
  codex = await waitForDifferentMainPid(brokerUnitName, firstCodexPid);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(hostDeck.mainPid, secondHostDeckPid);
  await waitForBrokerIdentityChange(firstBrokerIdentity, 30_000);
  await assertStandardBroker();
  await eventuallyReady(port, 30_000);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);
  const secondCodexPid = codex.mainPid;

  runSystemctl(["stop", brokerUnitName]);
  await requireInactiveUnit(brokerUnitName);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(hostDeck.mainPid, secondHostDeckPid);
  await eventuallyNotReady(port, 30_000);
  await assertLive(port);
  await waitForMissingPath(socketPath, 10_000);
  await waitForMissingPath(ownerPath, 10_000);
  assert.equal(existsSync(runtimeDir), true);

  runSystemctl(["start", brokerUnitName]);
  codex = await waitForDifferentMainPid(brokerUnitName, secondCodexPid);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(hostDeck.mainPid, secondHostDeckPid);
  await assertStandardBroker();
  await eventuallyReady(port, 30_000);
  const thirdSocketIdentity = socketIdentity();
  const thirdCodexPid = codex.mainPid;

  runSystemctl(["stop", hostDeckUnitName]);
  await requireInactiveUnit(hostDeckUnitName);
  codex = await requireActiveUnit(brokerUnitName);
  assert.equal(codex.mainPid, thirdCodexPid);
  assert.equal(socketIdentity(), thirdSocketIdentity);
  await assertStandardBroker();
  await assertRuntimeDirectoryRestored();
  await assertLoopbackPortAvailable(port);

  runSystemctl(["start", hostDeckUnitName]);
  await waitForUnitsReady(port, webIdentity);
  codex = await requireActiveUnit(brokerUnitName);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(codex.mainPid, thirdCodexPid);
  assert.equal(socketIdentity(), thirdSocketIdentity);
  const explicitStopHostDeckPid = hostDeck.mainPid;

  const explicitStop = runBrokerStopProbe();
  assert.equal(explicitStop.action, "stop");
  assert.equal(explicitStop.endpoint.kind, "standard_unix");
  assert.equal(explicitStop.endpoint.state, "absent");
  await requireInactiveUnit(brokerUnitName);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(hostDeck.mainPid, explicitStopHostDeckPid);
  await eventuallyNotReady(port, 30_000);
  await assertLive(port);
  await waitForMissingPath(socketPath, 10_000);
  await waitForMissingPath(ownerPath, 10_000);

  runSystemctl(["start", brokerUnitName]);
  codex = await waitForDifferentMainPid(brokerUnitName, thirdCodexPid);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(hostDeck.mainPid, explicitStopHostDeckPid);
  await assertStandardBroker();
  await eventuallyReady(port, 30_000);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);
  const leaseCodexPid = codex.mainPid;
  const leaseHostDeckPid = hostDeck.mainPid;
  const leaseSocketIdentity = socketIdentity();
  assertLeaseHeld();
  const foreground = runForegroundLeaseProbe(port);
  assert.equal(foreground.status, 70, foreground.stderr);
  assert.equal(foreground.signal, null);
  assert.equal(foreground.stdout, "");
  assert.equal(
    foreground.stderr,
    "HostDeck CLI error (runtime_unavailable): HostDeck foreground service failed during resources.\n"
  );
  assert.equal(foreground.stderr.includes(root), false);
  assert.equal(foreground.stderr.includes(codexBin), false);
  codex = await requireActiveUnit(brokerUnitName);
  hostDeck = await requireActiveUnit(hostDeckUnitName);
  assert.equal(codex.mainPid, leaseCodexPid);
  assert.equal(hostDeck.mainPid, leaseHostDeckPid);
  assert.equal(socketIdentity(), leaseSocketIdentity);
  await requireBrokerSupervisorProcessTree(codex, bundle.broker_host_path);
  await requireSingleMainProcess(hostDeck);
  assertNodeHostProcess(hostDeck.mainPid, bundle.service_host_path);
  await assertLocalSurface(port, webIdentity);

  const security = inspectUnitSecurity();
  assert.equal(security.length, 2);
  assert.deepEqual(observeTailscaleIdentity(), initialTailscaleIdentity);
  assert.deepEqual(
    findFiles(codexHome)
      .map((path) => relative(codexHome, path).split("\\").join("/"))
      .filter(
        (path) =>
          path === "history.jsonl" ||
          path.startsWith("sessions/") ||
          path.startsWith("archived_sessions/")
      )
      .sort((left, right) => left.localeCompare(right)),
    [],
    "Codex app-server created unexpected model-turn state."
  );

  await cleanupUnits();
  unitsLinked = false;
  assert.deepEqual(listFailedUserUnits(), initialFailedUnits);
  assert.deepEqual(observeTailscaleIdentity(), initialTailscaleIdentity);
  assertLeaseReleased();
  await assertRuntimeDirectoryRestored();
  assert.equal(existsSync(socketPath), false);
  assert.equal(existsSync(ownerPath), false);
  await assertLoopbackPortAvailable(port);
  console.log(
    `HostDeck systemd user-unit smoke passed: ${verification.sourceCount} sources, bundled Node, standard broker, independent restart/stop recovery, explicit owner-safe broker stop, lease exclusion, security inspection ${security.join("/")}, exact Codex ${sourceManifest.codex.codexVersion}, no model turn or persistent manager state.`
  );
} catch (error) {
  primaryError = error;
} finally {
  if (unitsLinked || linkedUnitPaths.some(existsSync)) {
    try {
      await cleanupUnits();
    } catch (error) {
      cleanupError = error;
    }
  }
  makeWritable(root);
  rmSync(root, { force: true, recursive: true });
}

if (primaryError !== null && cleanupError !== null) {
  throw new AggregateError(
    [primaryError, cleanupError],
    "Systemd user-unit smoke and cleanup both failed."
  );
}
if (primaryError !== null) throw primaryError;
if (cleanupError !== null) throw cleanupError;

function writeEnvironmentFile(port) {
  const values = {
    CODEX_HOME: codexHome,
    HOME: homeDir,
    HOSTDECK_PORT: String(port),
    PATH: commandDir,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome
  };
  assert.equal("HOSTDECK_CODEX_BIN" in values, false);
  assert.equal("XDG_RUNTIME_DIR" in values, false);
  const content = `${Object.entries(values)
    .map(([name, value]) => `${name}=${escapeEnvironmentFileValue(value)}`)
    .join("\n")}\n`;
  writeFileSync(environmentFile, content, { mode: 0o600 });
  chmodSync(environmentFile, 0o600);
}

function verifyGeneratedUnits(paths) {
  const result = runCommand("systemd-analyze", ["verify", "--user", ...paths], {
    allowedStatuses: [0]
  });
  assert.equal(`${result.stdout}${result.stderr}`, "");
}

function isolateGeneratedUnit(unit) {
  if (unit.name === canonicalUnitNames[0]) {
    return Object.freeze({ content: unit.content, name: brokerUnitName });
  }
  assert.equal(unit.name, canonicalUnitNames[1]);
  const content = unit.content
    .replaceAll(canonicalUnitNames[0], brokerUnitName)
    .replace(
      "RuntimeDirectory=hostdeck-service",
      `RuntimeDirectory=${unitPrefix}`
    );
  assert.notEqual(content, unit.content);
  assert.equal(content.includes(canonicalUnitNames[0]), false);
  return Object.freeze({ content, name: hostDeckUnitName });
}

function inspectUnitSecurity() {
  return unitNames.map((name) => {
    const result = runCommand(
      "systemd-analyze",
      ["security", "--user", "--no-pager", name],
      { allowedStatuses: [0, 1] }
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Overall exposure level for /u);
    assert.doesNotMatch(output, /Failed to (?:load|connect)|No such file/u);
    const match = output.match(/Overall exposure level for .*?:\s+([0-9.]+)/u);
    assert(match !== null);
    return match[1];
  });
}

async function waitForUnitsReady(port, webIdentity) {
  await requireActiveUnit(brokerUnitName);
  await requireActiveUnit(hostDeckUnitName);
  await assertStandardBroker();
  await assertLocalSurface(port, webIdentity);
}

async function assertLocalSurface(port, webIdentity) {
  await eventuallyLive(port, 30_000);
  await eventuallyReady(port, 30_000);
  await assertProductionWebHttpSurface(
    `http://127.0.0.1:${port}`,
    webIdentity,
    fetchWithTimeout
  );
}

async function assertLive(port) {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${port}/api/v1/health/live`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "alive" });
}

async function eventuallyLive(port, timeoutMs) {
  await eventually(async () => {
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/v1/health/live`
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }, timeoutMs, "HostDeck liveness did not become available.");
}

async function eventuallyReady(port, timeoutMs) {
  await eventually(async () => {
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/v1/health/ready`
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }, timeoutMs, "HostDeck readiness did not become ready.");
}

async function eventuallyNotReady(port, timeoutMs) {
  await eventually(async () => {
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/v1/health/ready`
      );
      return response.status !== 200;
    } catch {
      return false;
    }
  }, timeoutMs, "HostDeck readiness did not report unavailable.");
}

async function requireActiveUnit(name) {
  let snapshot = null;
  await eventually(async () => {
    snapshot = unitSnapshot(name);
    return (
      snapshot.activeState === "active" &&
      snapshot.subState === "running" &&
      snapshot.mainPid > 0
    );
  }, 30_000, `${name} did not become active.`);
  assert(snapshot !== null);
  process.kill(snapshot.mainPid, 0);
  return snapshot;
}

async function requireInactiveUnit(name) {
  await eventually(async () => {
    const snapshot = unitSnapshot(name);
    return snapshot.activeState === "inactive" && snapshot.mainPid === 0;
  }, 15_000, `${name} did not become inactive.`);
}

async function waitForDifferentMainPid(name, priorPid) {
  let snapshot = null;
  await eventually(async () => {
    snapshot = unitSnapshot(name);
    return (
      snapshot.activeState === "active" &&
      snapshot.subState === "running" &&
      snapshot.mainPid > 0 &&
      snapshot.mainPid !== priorPid
    );
  }, 30_000, `${name} did not replace its main process.`);
  return snapshot;
}

function unitSnapshot(name) {
  const result = runSystemctl([
    "show",
    name,
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--property=ControlGroup",
    "--property=LoadState"
  ]);
  const values = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1);
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  const mainPid = Number(values.MainPID);
  assert.equal(Number.isSafeInteger(mainPid), true);
  return Object.freeze({
    activeState: values.ActiveState,
    controlGroup: values.ControlGroup,
    loadState: values.LoadState,
    mainPid,
    name,
    subState: values.SubState
  });
}

async function requireSingleMainProcess(snapshot) {
  await eventually(async () => {
    const pids = readControlGroupPids(snapshot.controlGroup);
    return pids.length === 1 && pids[0] === snapshot.mainPid;
  }, 10_000, `${snapshot.name} did not settle to one main process.`);
}

async function requireBrokerSupervisorProcessTree(snapshot, brokerHostPath) {
  let owner = null;
  await eventually(async () => {
    try {
      owner = readBrokerOwner();
      const pids = readControlGroupPids(snapshot.controlGroup);
      return (
        owner.pid !== snapshot.mainPid &&
        pids.includes(snapshot.mainPid) &&
        pids.includes(owner.pid) &&
        isNodeHostProcess(snapshot.mainPid, brokerHostPath)
      );
    } catch {
      return false;
    }
  }, 30_000, `${snapshot.name} did not retain its supervisor and owned broker.`);
  assert(owner !== null);
  assert.equal(owner.socket_identity, socketIdentity());
  assertUnprivilegedProcess(owner.pid);
}

function readControlGroupPids(controlGroup) {
  const path = join("/sys/fs/cgroup", controlGroup, "cgroup.procs");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .sort((left, right) => left - right);
}

function assertNodeHostProcess(pid, hostPath) {
  assert.equal(isNodeHostProcess(pid, hostPath), true);
}

function isNodeHostProcess(pid, hostPath) {
  try {
    const executable = realpathSync(`/proc/${pid}/exe`);
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    return executable === bundledNode && args.includes(hostPath);
  } catch {
    return false;
  }
}

function assertUnprivilegedProcess(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const uidMatch = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu);
  const capabilityMatch = status.match(/^CapEff:\s+([a-f0-9]+)$/mu);
  assert(uidMatch !== null && capabilityMatch !== null);
  assert.deepEqual(uidMatch.slice(1).map(Number), [uid, uid, uid, uid]);
  assert.equal(Number.parseInt(capabilityMatch[1], 16), 0);
}

async function assertStandardBroker() {
  await eventually(async () => existsSync(socketPath) && (await probeSocket()), 30_000, "Codex socket did not become usable.");
  const directoryStats = lstatSync(controlDir);
  const socketStats = lstatSync(socketPath);
  const ownerStats = lstatSync(ownerPath);
  assert.equal(directoryStats.isDirectory(), true);
  assert.equal(directoryStats.uid, uid);
  assert.equal(directoryStats.mode & 0o7777, 0o700);
  assert.equal(socketStats.isSocket(), true);
  assert.equal(socketStats.uid, uid);
  assert.equal(socketStats.mode & 0o7777, 0o600);
  assert.equal(ownerStats.isFile(), true);
  assert.equal(ownerStats.uid, uid);
  assert.equal(ownerStats.mode & 0o7777, 0o600);
  const owner = readBrokerOwner();
  assert.equal(owner.socket_identity, socketIdentity());
  process.kill(owner.pid, 0);
}

function readBrokerOwner() {
  const value = JSON.parse(readFileSync(ownerPath, "utf8"));
  assert.equal(value.schema, 1);
  assert.equal(Number.isSafeInteger(value.pid) && value.pid > 0, true);
  assert.equal(value.process_group_id, value.pid);
  assert.equal(typeof value.start_ticks, "string");
  assert.equal(typeof value.executable, "string");
  assert.equal(Array.isArray(value.argv), true);
  assert.equal(typeof value.socket_identity, "string");
  assert.equal(typeof value.started_at, "string");
  return value;
}

function socketIdentity() {
  const stats = lstatSync(socketPath);
  assert.equal(stats.isSocket(), true);
  return `${stats.dev}:${stats.ino}`;
}

function brokerIdentity() {
  const owner = readBrokerOwner();
  return `${owner.pid}:${owner.start_ticks}`;
}

async function waitForBrokerIdentityChange(previous, timeoutMs) {
  await eventually(
    async () =>
      existsSync(ownerPath) &&
      brokerIdentity() !== previous &&
      existsSync(socketPath) &&
      (await probeSocket()),
    timeoutMs,
    "Owned Codex broker identity did not change."
  );
}

function probeSocket() {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveProbe(false);
    });
  });
}

function assertLoopbackOnlyListener(port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((path) =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields[1]?.endsWith(`:${portHex}`) && fields[3] === "0A")
      .map((fields) => fields[1])
  );
  assert.deepEqual(listeners, [`0100007F:${portHex}`]);
}

function runForegroundLeaseProbe(port) {
  const command = join(sourcePackage, sourceManifest.command.path);
  return runCommand(
    command,
    [
      `--port=${port}`,
      "--state-dir",
      stateDir,
      "--database",
      databasePath,
      "serve"
    ],
    {
      allowedStatuses: [70],
      cwd: root,
      env: {
        CODEX_HOME: codexHome,
        HOME: homeDir,
        HOSTDECK_CODEX_BIN: codexBin,
        PATH: commandDir,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: foregroundRuntimeHome,
        XDG_STATE_HOME: stateHome
      },
      timeout: 30_000
    }
  );
}

function runBrokerStopProbe() {
  const command = join(packageRoot, sourceManifest.command.path);
  const result = runCommand(command, ["broker", "stop", "--json"], {
    allowedStatuses: [0],
    cwd: root,
    env: {
      CODEX_HOME: codexHome,
      HOME: homeDir,
      HOSTDECK_CODEX_BIN: codexBin,
      PATH: commandDir,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: foregroundRuntimeHome,
      XDG_STATE_HOME: stateHome
    },
    timeout: 30_000
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(root), false);
  return JSON.parse(result.stdout);
}

async function cleanupUnits() {
  const errors = [];
  for (const name of [hostDeckUnitName, brokerUnitName]) {
    try {
      runSystemctl(["stop", name]);
    } catch (error) {
      errors.push(error);
    }
  }
  const failedUnits = listFailedUserUnits();
  for (const name of unitNames.filter((name) => failedUnits.includes(name))) {
    try {
      runSystemctl(["reset-failed", name]);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const path of linkedUnitPaths) {
    try {
      if (existsSync(path) || lstatOrNull(path) !== null) rmSync(path);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    runSystemctl(["daemon-reload"]);
  } catch (error) {
    errors.push(error);
  }
  try {
    await assertRuntimeDirectoryRestored();
    await waitForMissingPath(socketPath, 10_000);
    await waitForMissingPath(ownerPath, 10_000);
    for (const name of unitNames) {
      const snapshot = unitSnapshot(name);
      assert.equal(snapshot.loadState, "not-found");
      assert.equal(snapshot.mainPid, 0);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Systemd user-unit cleanup failed.");
  }
}

function assertCleanPreflight() {
  for (const path of linkedUnitPaths) assert.equal(lstatOrNull(path), null);
  for (const name of unitNames) {
    const snapshot = unitSnapshot(name);
    assert.equal(snapshot.loadState, "not-found");
    assert.equal(snapshot.mainPid, 0);
  }
  assertRuntimeDirectoryBaseline();
  assert.equal(lstatOrNull(socketPath), null);
  assert.equal(lstatOrNull(ownerPath), null);
}

function assertLinkedUnits(generatedPaths) {
  for (const [index, path] of linkedUnitPaths.entries()) {
    const stats = lstatSync(path);
    assert.equal(stats.isSymbolicLink(), true);
    assert.equal(realpathSync(path), generatedPaths[index]);
    assert.equal(readlinkSync(path), generatedPaths[index]);
    assert.equal(unitSnapshot(unitNames[index]).loadState, "loaded");
  }
}

function assertLeaseReleased() {
  if (!existsSync(leasePath)) return;
  const result = runFileLockProbe(0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function assertLeaseHeld() {
  assert.equal(existsSync(leasePath), true);
  const result = runFileLockProbe(73);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function runFileLockProbe(expectedStatus) {
  const storage = sourceManifest.packages.find((entry) => entry.name === "@hostdeck/storage");
  assert.ok(storage !== undefined);
  const storageRequire = createRequire(
    realpathSync(join(packageRoot, storage.root, "package.json"))
  );
  const nativeModule = realpathSync(storageRequire.resolve("fs-native-extensions"));
  const source = [
    "const fs = require('node:fs');",
    "const lock = require(process.argv[1]);",
    "const descriptor = fs.openSync(process.argv[2], 'r+');",
    "let acquired = false;",
    "try { acquired = lock.tryLock(descriptor); if (acquired) lock.unlock(descriptor); } finally { fs.closeSync(descriptor); }",
    "process.exitCode = acquired ? 0 : 73;"
  ].join(" ");
  return runCommand(bundledNode, ["--eval", source, nativeModule, leasePath], {
    allowedStatuses: [expectedStatus]
  });
}

function listFailedUserUnits() {
  const result = runSystemctl([
    "list-units",
    "--failed",
    "--all",
    "--plain",
    "--no-legend"
  ]);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u)[0])
    .sort((left, right) => left.localeCompare(right));
}

function observeTailscaleIdentity() {
  const executable = "/usr/bin/tailscale";
  if (!existsSync(executable)) return Object.freeze({ installed: false });
  const status = runCommand(executable, ["status", "--json"], {
    allowedStatuses: [0]
  });
  const parsed = JSON.parse(status.stdout);
  const profiles = runCommand(executable, ["switch", "--list"], {
    allowedStatuses: [0]
  });
  const serve = runCommand(executable, ["serve", "status", "--json"], {
    allowedStatuses: [0]
  });
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

function runSystemctl(args) {
  return runCommand("systemctl", ["--user", "--no-pager", ...args], {
    allowedStatuses: [0]
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? "/",
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
      PAGER: "cat",
      SYSTEMD_COLORS: "0",
      SYSTEMD_PAGER: "cat"
    },
    maxBuffer: 1_048_576,
    shell: false,
    timeout: options.timeout ?? 30_000
  });
  assert.equal(result.error, undefined, `${command} failed to execute`);
  assert.equal(result.signal, null, `${command} was terminated by signal`);
  const allowedStatuses = options.allowedStatuses ?? [0];
  assert.equal(
    allowedStatuses.includes(result.status),
    true,
    `${command} ${args.join(" ")} exited ${result.status}: ${boundedOutput(result)}`
  );
  return result;
}

function requireExactCodexBinary(candidate, expectedVersion) {
  const path = requireCanonicalExecutable(candidate, "Codex");
  const result = runCommand(path, ["--version"], {
    allowedStatuses: [0],
    timeout: 10_000
  });
  assert.match(
    result.stdout,
    new RegExp(`(?:^|\\s)${escapeRegExp(expectedVersion)}(?:\\s|$)`, "u")
  );
  return path;
}

function requireCanonicalExecutable(candidate, label) {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) {
    throw new TypeError(`${label} executable must be an absolute path.`);
  }
  const path = realpathSync(candidate);
  const stats = lstatSync(path);
  if (
    path !== candidate ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o111) === 0 ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new TypeError(`${label} executable is unsafe or noncanonical.`);
  }
  return path;
}

function requireCurrentUid() {
  const selected = process.getuid?.();
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError("Systemd user-unit smoke requires an unprivileged Unix user.");
  }
  return selected;
}

function requireRuntimeHome(selectedUid) {
  const candidate = `/run/user/${selectedUid}`;
  const path = realpathSync(candidate);
  const stats = lstatSync(path);
  if (
    path !== candidate ||
    !stats.isDirectory() ||
    stats.uid !== selectedUid ||
    (stats.mode & 0o7777) !== 0o700
  ) {
    throw new TypeError("Systemd user runtime directory is invalid.");
  }
  return path;
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error)
    );
  });
  return port;
}

async function assertLoopbackPortAvailable(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port }, resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error)
    );
  });
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function waitForMissingPath(path, timeoutMs) {
  await eventually(async () => !existsSync(path), timeoutMs, `${path} was not removed.`);
}

function makeReadOnly(path, executableFiles) {
  const entries = findEntries(path).sort((left, right) => right.length - left.length);
  for (const entry of entries) {
    const stats = lstatSync(entry);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      chmodSync(entry, 0o555);
    } else if (stats.isFile()) {
      const logical = relative(path, entry).split("/").join("/");
      chmodSync(entry, executableFiles.has(logical) ? 0o555 : 0o444);
    }
  }
}

function normalizePackageModes(path, executableFiles) {
  const entries = findEntries(path).sort((left, right) => right.length - left.length);
  for (const entry of entries) {
    const stats = lstatSync(entry);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      chmodSync(entry, 0o755);
      continue;
    }
    if (stats.isFile()) {
      const relativePath = relative(path, entry).split("\\").join("/");
      chmodSync(entry, executableFiles.has(relativePath) ? 0o755 : 0o644);
    }
  }
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  for (const entry of findEntries(path)) {
    const stats = lstatSync(entry);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) chmodSync(entry, 0o700);
    else if (stats.isFile()) chmodSync(entry, 0o600);
  }
  chmodSync(path, 0o700);
}

function findEntries(path) {
  const entries = [path];
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return entries;
  for (const child of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, child.name);
    entries.push(target);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      entries.push(...findEntries(target).slice(1));
    }
  }
  return entries;
}

function findFiles(path) {
  return findEntries(path).filter((entry) => lstatSync(entry).isFile());
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function pathIdentityOrNull(path) {
  if (!existsSync(path)) return null;
  const stats = lstatSync(path);
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.uid, uid);
  assert.equal(stats.mode & 0o7777, 0o700);
  return `${stats.dev}:${stats.ino}`;
}

function assertRuntimeDirectoryBaseline() {
  assert.equal(pathIdentityOrNull(runtimeDir), initialRuntimeIdentity);
}

async function assertRuntimeDirectoryRestored() {
  if (initialRuntimeIdentity === null) {
    await waitForMissingPath(runtimeDir, 10_000);
    return;
  }
  assertRuntimeDirectoryBaseline();
}

function escapeEnvironmentFileValue(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")}"`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2_000);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
