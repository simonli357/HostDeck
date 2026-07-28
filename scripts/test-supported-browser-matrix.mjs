import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBrowserMatrixAggregate,
  publishBrowserMatrixEvidence,
  readBrowserMatrixEvidence,
  validateBuiltPackageIdentity
} from "./browser-matrix-evidence.mjs";
import { readSupportedBrowserManifest } from "./browser-support-manifest.mjs";
import { inspectSupportedBrowserRuntime } from "./supported-browser-preflight.mjs";
import { verifyProductionPackage } from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const playwrightOutput = join(tmpdir(), "hostdeck-playwright-e2e");
const temporaryRoot = mkdtempSync(join(tmpdir(), "hostdeck-browser-matrix-run-"));
const evidenceRoot = join(temporaryRoot, "evidence");
const tlsRoot = join(temporaryRoot, "tls");
const tlsKey = join(tlsRoot, "key.pem");
const tlsCertificate = join(tlsRoot, "certificate.pem");
const packageRoot = join(repositoryRoot, "dist", "hostdeck");
const packagePort = 4175;
const httpsPort = 4176;
const proxyPort = 4177;
mkdirSync(evidenceRoot, { mode: 0o700 });

let exitCode = 0;
let evidenceBundle = null;
let playwrightStarted = false;
try {
  removeOwnedPath(playwrightOutput);
  const manifest = readSupportedBrowserManifest();
  const inspection = await inspectSupportedBrowserRuntime();
  process.stdout.write(
    `Supported browser preflight passed: ${inspection.engines
      .map(({ browser_name, browser_version }) => `${browser_name} ${browser_version}`)
      .join(", ")}.\n`
  );
  exitCode = runPnpm(["build"]);
  if (exitCode === 0) {
    verifyProductionPackage(packageRoot);
    validateBuiltPackageIdentity(readJson(packageRoot, "hostdeck-package.json"), manifest);
    createEphemeralCertificate();
    playwrightStarted = true;
    exitCode = runPnpm(
      ["exec", "playwright", "test", "--config", "playwright.e2e.config.ts"],
      {
        HOSTDECK_BROWSER_EVIDENCE_TEMP_ROOT: evidenceRoot,
        HOSTDECK_BROWSER_HTTPS_CERTIFICATE: tlsCertificate,
        HOSTDECK_BROWSER_HTTPS_KEY: tlsKey,
        HOSTDECK_BROWSER_RUNTIME_INSPECTION: JSON.stringify(inspection),
        HOSTDECK_PACKAGE_BROWSER_TEMP_ROOT: temporaryRoot
      }
    );
    if (exitCode === 0) {
      evidenceBundle = readBrowserMatrixEvidence(evidenceRoot, manifest);
    }
  }
} finally {
  try {
    if (playwrightStarted) {
      await assertPortClosed(packagePort);
      await assertPortClosed(httpsPort);
      await assertPortClosed(proxyPort);
    }
  } finally {
    removeOwnedPath(playwrightOutput);
    removeOwnedPath(temporaryRoot);
  }
}

if (exitCode === 0) {
  if (evidenceBundle === null) {
    throw new TypeError("Supported browser evidence was not produced.");
  }
  if (existsSync(playwrightOutput) || existsSync(temporaryRoot)) {
    throw new TypeError("Supported browser matrix cleanup is incomplete.");
  }
  const aggregate = createBrowserMatrixAggregate(evidenceBundle, {
    web_servers_stopped: true,
    temporary_root_removed: true,
    playwright_output_removed: true
  });
  publishBrowserMatrixEvidence(evidenceBundle, aggregate);
  process.stdout.write(
    `Supported browser matrix passed and published ${evidenceBundle.reports.length} project reports.\n`
  );
}
process.exitCode = exitCode;

function createEphemeralCertificate() {
  mkdirSync(tlsRoot, { mode: 0o700 });
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:hostdeck-cookie.fixture-tailnet.ts.net,DNS:hostdeck-cookie-sibling.fixture-tailnet.ts.net,DNS:hostdeck-cookie-cross.other-fixture.ts.net",
    "-keyout",
    tlsKey,
    "-out",
    tlsCertificate
  ], {
    cwd: repositoryRoot,
    stdio: "ignore"
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new TypeError("Supported browser ephemeral certificate generation failed.");
  }
  chmodSync(tlsKey, 0o600);
  chmodSync(tlsCertificate, 0o600);
  for (const path of [tlsKey, tlsCertificate]) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > 32_768) {
      throw new TypeError("Supported browser ephemeral certificate output is invalid.");
    }
  }
}

function readJson(root, file) {
  const path = join(root, file);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > 262_144) {
    throw new TypeError("Supported browser package manifest file is invalid.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new TypeError("Supported browser package manifest is not valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("Supported browser package manifest is not valid JSON.");
  }
}

async function assertPortClosed(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isPortOpen(port))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new TypeError(`Supported browser fixture port ${port} remained open.`);
}

function isPortOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function runPnpm(args, environmentOverrides = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command =
    typeof npmExecPath === "string" && existsSync(npmExecPath)
      ? process.execPath
      : "pnpm";
  const commandArguments =
    command === process.execPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environmentOverrides },
    stdio: "inherit"
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== null) return result.status;
  process.stderr.write(
    `Supported browser matrix command terminated by ${result.signal ?? "an unknown signal"}.\n`
  );
  return 1;
}

function removeOwnedPath(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSymbolicLink()) makeWritable(path, stats);
  rmSync(path, { force: true, recursive: true });
}

function makeWritable(path, stats = lstatSync(path)) {
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      makeWritable(child, lstatSync(child));
    }
    return;
  }
  if (stats.isFile()) chmodSync(path, stats.mode & 0o111 ? 0o755 : 0o644);
}
