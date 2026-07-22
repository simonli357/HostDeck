import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const root = mkdtempSync(join(tmpdir(), "hostdeck-service-host-"));
const packageRoot = join(root, "package");
const homeDir = join(root, "home");
const configHome = join(root, "config-home");
const stateHome = join(root, "state-home");
const runtimeHome = join(root, "runtime-home");
const runtimeDir = join(runtimeHome, "hostdeck");
const socketPath = join(runtimeDir, "app-server.sock");
const codexHome = join(root, "codex-home");
const commandDir = join(root, "bin");
const staticMarker = "SERVICE_HOST_SMOKE";
let appServer = null;
let hostDeck = null;

try {
  cpSync(sourcePackage, packageRoot, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
  createStaticFixture(join(packageRoot, "web"));
  for (const path of [
    homeDir,
    configHome,
    stateHome,
    runtimeHome,
    runtimeDir,
    codexHome,
    commandDir
  ]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    chmodSync(path, 0o700);
  }
  symlinkSync(process.execPath, join(commandDir, "node"));
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "hostdeck-package.json"), "utf8")
  );
  assert.equal(manifest.serviceHost.path, "dist/service-host.js");
  assert.equal(manifest.executableFiles.includes(manifest.serviceHost.path), false);
  makeReadOnly(packageRoot, new Set(manifest.executableFiles));
  const serviceHostPath = join(packageRoot, manifest.serviceHost.path);
  const port = await availableLoopbackPort();
  const environment = {
    CODEX_HOME: codexHome,
    HOME: homeDir,
    HOSTDECK_CODEX_BIN: codexBin,
    HOSTDECK_PORT: String(port),
    PATH: commandDir,
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeHome,
    XDG_STATE_HOME: stateHome
  };
  assertTailscaleUnavailable(environment);

  appServer = startAppServer(codexBin, environment);
  await waitForSocket(socketPath, appServer, 30_000);
  await assertPrivateExternalSocket(socketPath);

  hostDeck = startServiceHost(serviceHostPath, environment, port);
  await withTimeout(hostDeck.ready, 30_000, "Service HostDeck A did not become ready.");
  await assertLocalSurface(port);

  const firstAppServerPid = requireRunningPid(appServer.child, "app-server A");
  await stopChild(appServer, "SIGTERM", 30_000, "app-server A");
  appServer = null;
  assert.equal(hostDeck.child.exitCode, null);
  assert.equal(hostDeck.child.signalCode, null);

  rmSync(runtimeDir, { force: true, recursive: true });
  mkdirSync(runtimeDir, { mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  appServer = startAppServer(codexBin, environment);
  await waitForSocket(socketPath, appServer, 30_000);
  await assertPrivateExternalSocket(socketPath);
  const secondAppServerPid = requireRunningPid(appServer.child, "app-server B");
  assert.notEqual(secondAppServerPid, firstAppServerPid);
  await eventuallyReady(port, 30_000);
  assert.equal(hostDeck.child.exitCode, null);
  assert.equal(hostDeck.child.signalCode, null);

  await stopChild(hostDeck, "SIGTERM", 30_000, "HostDeck A");
  hostDeck = null;
  assert.equal(requireRunningPid(appServer.child, "app-server B"), secondAppServerPid);
  await assertPrivateExternalSocket(socketPath);
  const socketIdentity = socketIdentityOf(socketPath);

  hostDeck = startServiceHost(serviceHostPath, environment, port);
  await withTimeout(hostDeck.ready, 30_000, "Service HostDeck B did not become ready.");
  await assertLocalSurface(port);
  await stopChild(hostDeck, "SIGTERM", 30_000, "HostDeck B");
  hostDeck = null;
  assert.equal(requireRunningPid(appServer.child, "app-server B"), secondAppServerPid);
  assert.equal(socketIdentityOf(socketPath), socketIdentity);
  await assertPrivateExternalSocket(socketPath);

  await stopChild(appServer, "SIGTERM", 30_000, "app-server B");
  appServer = null;
  assert.equal(existsSync(socketPath), false);
  await assertLoopbackPortAvailable(port);
  assert.equal(
    findFiles(codexHome).some((path) => path.endsWith(".jsonl")),
    false
  );
  assert.equal(existsSync(join(stateHome, "hostdeck", "hostdeck.lock")), true);
  console.log(
    `HostDeck service-host smoke passed: ${verification.sourceCount} sources, read-only package, one app-server replacement, two HostDeck lifetimes, exact Codex ${sourceManifest.codex.codexVersion}, no model turn.`
  );
} finally {
  try {
    if (hostDeck !== null) {
      await forceStop(hostDeck);
    }
    if (appServer !== null) {
      await forceStop(appServer);
    }
  } finally {
    makeWritable(root);
    rmSync(root, { force: true, recursive: true });
  }
}

function startAppServer(executable, environment) {
  const child = spawn(
    executable,
    ["app-server", "--listen", `unix://${socketPath}`],
    {
      cwd: "/",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return captureChild(child, "app-server");
}

function assertTailscaleUnavailable(environment) {
  const result = spawnSync("tailscale", ["status", "--json"], {
    cwd: "/",
    encoding: "utf8",
    env: environment,
    maxBuffer: 65_536,
    shell: false,
    timeout: 5_000
  });
  assert.equal(result.status, null);
  assert.equal(result.signal, null);
  assert.equal(result.error?.code, "ENOENT");
}

function startServiceHost(serviceHostPath, environment, port) {
  const expectedReady = `HostDeck service ready at http://127.0.0.1:${port}.\n`;
  const child = spawn(process.execPath, [serviceHostPath], {
    cwd: root,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const captured = captureChild(child, "HostDeck service");
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  captured.onStdout = (stdout) => {
    if (!readySettled && stdout === expectedReady) {
      readySettled = true;
      resolveReady();
    }
  };
  void captured.completed.then(
    (result) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(
            `HostDeck service exited before readiness (${result.code ?? "none"}/${result.signal ?? "none"}).`
          )
        );
      }
    },
    (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
    }
  );
  return { ...captured, ready };
}

function captureChild(child, label) {
  const maximumOutputBytes = 1_048_576;
  let stdout = "";
  let stderr = "";
  let outputFailure = null;
  const captured = {
    child,
    completed: null,
    onStdout: () => undefined
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      stdout = appendBounded(stdout, chunk, maximumOutputBytes);
      captured.onStdout(stdout);
    } catch (error) {
      failOutput(error);
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      stderr = appendBounded(stderr, chunk, maximumOutputBytes);
    } catch (error) {
      failOutput(error);
    }
  });
  captured.completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once("error", (error) => rejectCompleted(error));
    child.once("exit", (code, signal) => {
      if (outputFailure !== null) {
        rejectCompleted(outputFailure);
      } else {
        resolveCompleted({ code, signal, stderr, stdout });
      }
    });
  });
  void captured.completed.catch(() => undefined);
  return captured;

  function failOutput(error) {
    if (outputFailure !== null) return;
    outputFailure = new Error(`${label} output exceeded its capture bound.`, {
      cause: error
    });
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function stopChild(owner, signal, timeoutMs, label) {
  assert.equal(owner.child.exitCode, null, `${label} exited before stop`);
  assert.equal(owner.child.signalCode, null, `${label} was signaled before stop`);
  assert.equal(owner.child.kill(signal), true, `${label} did not accept ${signal}`);
  const result = await withTimeout(
    owner.completed,
    timeoutMs,
    `${label} did not terminate.`
  );
  if (label.startsWith("HostDeck")) {
    assert.equal(result.code, 0, `${label} returned nonzero`);
    assert.equal(result.signal, null, `${label} exited by signal`);
    assert.match(result.stdout, /^HostDeck service ready at http:\/\/127\.0\.0\.1:\d+\.\n$/u);
    assert.equal(result.stderr, "");
  } else {
    assert.equal(result.code === 0 || result.signal === signal, true);
  }
}

async function forceStop(owner) {
  if (owner.child.exitCode === null && owner.child.signalCode === null) {
    owner.child.kill("SIGKILL");
  }
  await withTimeout(owner.completed.catch(() => undefined), 5_000, "Child cleanup timed out.").catch(
    () => undefined
  );
}

async function waitForSocket(path, owner, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
      throw new Error("App-server exited before socket readiness.");
    }
    if (existsSync(path) && (await probeSocket(path))) return;
    await sleep(20);
  }
  throw new Error("App-server socket did not become ready.");
}

function probeSocket(path) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ path });
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

async function assertPrivateExternalSocket(path) {
  const stats = lstatSync(path);
  assert.equal(stats.isSocket(), true);
  assert.equal(stats.mode & 0o7777, 0o600);
  assert.equal(lstatSync(dirname(path)).mode & 0o7777, 0o700);
  assert.equal(await probeSocket(path), true);
}

async function assertLocalSurface(port) {
  const live = await fetchWithTimeout(
    `http://127.0.0.1:${port}/api/v1/health/live`
  );
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "alive" });
  await eventuallyReady(port, 30_000);
  const index = await fetchWithTimeout(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), new RegExp(staticMarker, "u"));
}

async function eventuallyReady(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/v1/health/ready`
      );
      if (response.status === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("HostDeck local readiness did not recover.");
}

function requireExactCodexBinary(candidate, expectedVersion) {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) {
    throw new TypeError(
      "Service-host smoke requires absolute HOSTDECK_CODEX_BIN."
    );
  }
  const path = realpathSync(candidate);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || path !== candidate) {
    throw new TypeError("Service-host smoke Codex binary is noncanonical.");
  }
  const result = spawnSync(path, ["--version"], {
    cwd: "/",
    encoding: "utf8",
    maxBuffer: 65_536,
    timeout: 10_000
  });
  if (
    result.status !== 0 ||
    !new RegExp(`(?:^|\\s)${escapeRegExp(expectedVersion)}(?:\\s|$)`, "u").test(
      result.stdout
    )
  ) {
    throw new TypeError("Service-host smoke Codex version is unsupported.");
  }
  return path;
}

function createStaticFixture(buildRoot) {
  mkdirSync(join(buildRoot, "assets"), { mode: 0o755, recursive: true });
  writeFileSync(
    join(buildRoot, "index.html"),
    `<!doctype html><html><body>${staticMarker}</body></html>\n`,
    { mode: 0o644 }
  );
  writeFileSync(join(buildRoot, "assets", "app-12345678.js"), "export {};\n", {
    mode: 0o644
  });
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

function appendBounded(current, chunk, maximumBytes) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next, "utf8") > maximumBytes) {
    throw new Error("Output exceeded its byte bound.");
  }
  return next;
}

function socketIdentityOf(path) {
  const stats = lstatSync(path);
  assert.equal(stats.isSocket(), true);
  return `${stats.dev}:${stats.ino}`;
}

function requireRunningPid(child, label) {
  if (
    child.pid === undefined ||
    child.pid < 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    throw new Error(`${label} is not running.`);
  }
  process.kill(child.pid, 0);
  return child.pid;
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
  return findEntries(path).filter((entry) => {
    try {
      return lstatSync(entry).isFile();
    } catch {
      return false;
    }
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
