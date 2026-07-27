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
import { request as requestHttp } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
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
const expectDiagnostic = process.env.HOSTDECK_EXPECT_DIAGNOSTIC === "1";
const codex = requireCodexBinary(
  process.env.HOSTDECK_CODEX_BIN,
  sourceManifest.codex.codexVersion,
  expectDiagnostic
);
const codexBin = codex.path;
const root = mkdtempSync(join(homedir(), ".hostdeck-executable-serve-"));
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
    const localAdminHeaders = {
      "x-hostdeck-local-admin": "cli-v1"
    };
    const hostStatusResponse = await requestLoopback(
      `http://127.0.0.1:${port}/api/v1/host/status`,
      { headers: localAdminHeaders }
    );
    assert.equal(hostStatusResponse.status, 200);
    assert.equal(hostStatusResponse.headers.get("cache-control"), "no-store");
    const hostStatus = await hostStatusResponse.json();
    assert.deepEqual(hostStatus.compatibility, {
      state: expectDiagnostic ? "version_drift" : "supported",
      evidence: "current",
      observed_version: codex.version,
      supported_version: sourceManifest.codex.codexVersion,
      capability_state: expectDiagnostic ? "blocked" : "verified",
      checked_at: hostStatus.compatibility.checked_at,
      recorded_at: hostStatus.compatibility.recorded_at
    });
    assert.equal(
      typeof hostStatus.compatibility.checked_at,
      "string"
    );
    assert.equal(
      typeof hostStatus.compatibility.recorded_at,
      "string"
    );
    assert.equal(
      hostStatus.local.readiness,
      expectDiagnostic ? "not_ready" : "ready"
    );
    assert.equal(
      hostStatus.local.mutation_admission,
      expectDiagnostic ? "closed" : "open"
    );
    assert.equal(
      /binding_id|capabilities|reason|socket|codex_bin|user_agent|environment/iu.test(
        JSON.stringify(hostStatus.compatibility)
      ),
      false
    );
    const readiness = await requestLoopback(
      `http://127.0.0.1:${port}/api/v1/health/ready`,
      { headers: localAdminHeaders }
    );
    assert.equal(readiness.status, expectDiagnostic ? 503 : 200);

    if (expectDiagnostic) {
      const stream = await requestLoopback(
        `http://127.0.0.1:${port}/api/v1/sessions/sess_diagnostic_smoke_001/events/stream`,
        {
          headers: { accept: "text/event-stream" }
        }
      );
      assert.equal(stream.status, 503);
      assert.equal((await stream.json()).error.code, "service_overloaded");

      const mutation = await requestLoopback(
        `http://127.0.0.1:${port}/api/v1/sessions`,
        {
          body: JSON.stringify({
            operation_id: `op_diagnostic_package_${attempt}`,
            name: "diagnostic-blocked",
            cwd: "/tmp/hostdeck-diagnostic-blocked"
          }),
          headers: {
            ...localAdminHeaders,
            "content-type": "application/json"
          },
          method: "POST"
        }
      );
      assert.equal(mutation.status, 409);
      assert.equal((await mutation.json()).error.code, "incompatible_runtime");
      assert.equal(existsSync(socketPath), false);
    }

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
    expectDiagnostic
      ? `HostDeck executable diagnostic smoke passed: ${verification.sourceCount} sources, read-only package, two loopback starts, observed Codex ${codex.version}, no runtime admission.`
      : `HostDeck executable serve smoke passed: ${verification.sourceCount} sources, read-only package, two loopback starts, exact Codex ${sourceManifest.codex.codexVersion}, no model turn.`
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

function requireCodexBinary(candidate, expectedVersion, diagnostic) {
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
  const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\n?$/u.exec(
    result.stdout
  );
  const observedVersion = match?.[1];
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    observedVersion === undefined ||
    (diagnostic
      ? observedVersion === expectedVersion
      : observedVersion !== expectedVersion)
  ) {
    throw new TypeError(
      diagnostic
        ? "Executable diagnostic smoke requires a valid unsupported Codex version."
        : "Executable serve smoke Codex version is unsupported."
    );
  }
  return Object.freeze({ path, version: observedVersion });
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

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { connection: "close", ...init.headers },
    signal: AbortSignal.timeout(5_000)
  });
}

async function requestLoopback(url, init = {}) {
  const target = new URL(url);
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  assert(init.body === undefined || typeof init.body === "string");

  return await new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectRequest(error);
    };
    const request = requestHttp(
      target,
      {
        headers: { connection: "close", ...init.headers },
        method: init.method ?? "GET",
        signal: AbortSignal.timeout(5_000)
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (!Buffer.isBuffer(chunk)) {
            request.destroy(
              new Error("Executable serve response was not a byte buffer.")
            );
            return;
          }
          bytes += chunk.byteLength;
          if (bytes > 1_048_576) {
            request.destroy(
              new Error("Executable serve response exceeded its smoke bound.")
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", rejectOnce);
        response.once("end", () => {
          if (settled) return;
          const status = response.statusCode;
          if (status === undefined) {
            rejectOnce(
              new Error("Executable serve response omitted its status code.")
            );
            return;
          }
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(
              response.rawHeaders[index],
              response.rawHeaders[index + 1]
            );
          }
          settled = true;
          resolveRequest(
            new Response(Buffer.concat(chunks, bytes), { headers, status })
          );
        });
      }
    );
    request.once("error", rejectOnce);
    if (init.body !== undefined) request.write(init.body);
    request.end();
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
