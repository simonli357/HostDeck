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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
const root = mkdtempSync(join(tmpdir(), "hostdeck-executable-serve-"));
const packageRoot = join(root, "package");
const homeDir = join(root, "home");
const configHome = join(root, "config-home");
const stateHome = join(root, "state-home");
const stateDir = join(stateHome, "hostdeck");
const databasePath = join(stateDir, "hostdeck.sqlite");
const runtimeHome = join(root, "runtime-home");
const runtimeDir = join(runtimeHome, "hostdeck");
const socketPath = join(runtimeDir, "app-server.sock");
const codexHome = join(root, "codex-home");
const commandDir = join(root, "bin");
let activeRun = null;

try {
  cpSync(sourcePackage, packageRoot, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
  createStaticFixture(join(packageRoot, "web"));
  for (const path of [homeDir, runtimeHome, codexHome, commandDir]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    chmodSync(path, 0o700);
  }
  symlinkSync(process.execPath, join(commandDir, "node"));
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "hostdeck-package.json"), "utf8")
  );
  makeReadOnly(packageRoot, new Set(manifest.executableFiles));
  const command = join(packageRoot, manifest.command.path);
  const port = await availableLoopbackPort();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = startServe(command, port);
    activeRun = run;
    await withTimeout(run.ready, 30_000, "Executable serve did not become ready.");
    const live = await fetchWithTimeout(
      `http://127.0.0.1:${port}/api/v1/health/live`
    );
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "alive" });
    const index = await fetchWithTimeout(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /EXECUTABLE_SERVE_SMOKE/u);
    const asset = await fetchWithTimeout(
      `http://127.0.0.1:${port}/assets/app-12345678.js`
    );
    assert.equal(asset.status, 200);
    assert.equal(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable"
    );

    assert.equal(run.child.kill("SIGTERM"), true);
    const result = await withTimeout(
      run.completed,
      30_000,
      "Executable serve did not terminate."
    );
    activeRun = null;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(
      result.stdout,
      `HostDeck foreground service ready at http://127.0.0.1:${port}.\n`
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(root), false);
    assert.equal(existsSync(socketPath), false);
    await assertLoopbackPortAvailable(port);
  }

  assert.equal(findFiles(codexHome).some((path) => path.endsWith(".jsonl")), false);
  console.log(
    `HostDeck executable serve smoke passed: ${verification.sourceCount} sources, read-only package, two loopback starts, exact Codex ${sourceManifest.codex.codexVersion}, no model turn.`
  );
} finally {
  try {
    if (activeRun !== null) {
      if (
        activeRun.child.exitCode === null &&
        activeRun.child.signalCode === null
      ) {
        activeRun.child.kill("SIGKILL");
      }
      await withTimeout(
        activeRun.completed.catch(() => undefined),
        5_000,
        "Executable serve cleanup did not terminate the child process."
      );
    }
  } finally {
    makeWritable(root);
    rmSync(root, { force: true, recursive: true });
  }
}

function startServe(command, port) {
  const expectedReady = `HostDeck foreground service ready at http://127.0.0.1:${port}.\n`;
  const child = spawn(
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
      cwd: root,
      env: {
        CODEX_HOME: codexHome,
        HOME: homeDir,
        HOSTDECK_CODEX_BIN: codexBin,
        PATH: commandDir,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: runtimeHome,
        XDG_STATE_HOME: stateHome
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let outputFailure = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      stdout = appendBounded(stdout, chunk);
      if (!readySettled && stdout === expectedReady) {
        readySettled = true;
        resolveReady();
      }
    } catch (error) {
      failOutputCapture(error);
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      stderr = appendBounded(stderr, chunk);
    } catch (error) {
      failOutputCapture(error);
    }
  });
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("Executable serve process could not start."));
      }
      rejectCompleted(error);
    });
    child.once("exit", (code, signal) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(
            `Executable serve exited before readiness (${code ?? "none"}/${signal ?? "none"}): ${stderr}`
          )
        );
      }
      if (outputFailure === null) {
        resolveCompleted({ code, signal, stderr, stdout });
      } else {
        rejectCompleted(outputFailure);
      }
    });
  });
  void completed.catch(() => undefined);

  function failOutputCapture(error) {
    if (outputFailure !== null) return;
    outputFailure = error;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  return { child, completed, ready };
}

function requireExactCodexBinary(candidate, expectedVersion) {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) {
    throw new TypeError(
      "Executable serve smoke requires absolute HOSTDECK_CODEX_BIN."
    );
  }
  const path = realpathSync(candidate);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || path !== candidate) {
    throw new TypeError("Executable serve smoke Codex binary is noncanonical.");
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
    throw new TypeError("Executable serve smoke Codex version is unsupported.");
  }
  return path;
}

function createStaticFixture(buildRoot) {
  mkdirSync(join(buildRoot, "assets"), { mode: 0o755, recursive: true });
  writeFileSync(
    join(buildRoot, "index.html"),
    "<!doctype html><html><body>EXECUTABLE_SERVE_SMOKE</body></html>\n",
    { mode: 0o644 }
  );
  writeFileSync(
    join(buildRoot, "assets", "app-12345678.js"),
    "export {};\n",
    { mode: 0o644 }
  );
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
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
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
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function fetchWithTimeout(url) {
  return fetch(url, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(5_000)
  });
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") > 1_048_576) {
    throw new Error("Executable serve output exceeded its smoke bound.");
  }
  return next;
}

function makeReadOnly(rootPath, executables) {
  const directories = [];
  visit(rootPath, (path, stats) => {
    if (stats.isDirectory()) directories.push(path);
    else if (stats.isFile()) {
      const relativePath = path.slice(rootPath.length + 1).split(sep).join("/");
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

function findFiles(path) {
  if (!existsSync(path)) return [];
  const files = [];
  visit(path, (candidate, stats) => {
    if (stats.isFile()) files.push(candidate);
  });
  return files;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
