import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProductionPackage } from "./build-production-package.mjs";
import { verifyProductionPackage } from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputRoot = join(repositoryRoot, "dist", "hostdeck");
const distRoot = dirname(outputRoot);
const staleSentinel = join(outputRoot, "undeclared-stale-sentinel");
let acceptanceRoot = null;

try {
  mkdirSync(outputRoot, { mode: 0o755, recursive: true });
  writeFileSync(staleSentinel, "stale\n", { mode: 0o644 });
  const first = buildProductionPackage({ repositoryRoot });
  assert.equal(lstatOrNull(staleSentinel), null, "clean build must replace stale output");
  const firstManifestText = readFileSync(join(outputRoot, "hostdeck-package.json"), "utf8");
  const firstManifest = JSON.parse(firstManifestText);

  const second = buildProductionPackage({ repositoryRoot });
  const secondManifestText = readFileSync(join(outputRoot, "hostdeck-package.json"), "utf8");
  const secondManifest = JSON.parse(secondManifestText);
  assert.deepEqual(second, first, "two unchanged builds must return identical identities");
  assert.equal(secondManifestText, firstManifestText, "two unchanged builds must emit the same manifest bytes");
  assert.deepEqual(secondManifest, firstManifest);
  assert.deepEqual(
    readdirSync(distRoot).filter((name) => name.startsWith(".hostdeck")),
    [],
    "build must leave no staging or previous-output directory"
  );

  acceptanceRoot = mkdtempSync(join(tmpdir(), "hostdeck-package-acceptance-"));
  const relocated = join(acceptanceRoot, "relocated", "hostdeck");
  mkdirSync(dirname(relocated), { recursive: true });
  cpSync(outputRoot, relocated, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
  const smokeScript = join(acceptanceRoot, "run-package-smoke.mjs");
  copyFileSync(join(scriptDirectory, "run-production-package-smoke.mjs"), smokeScript);
  const unrelatedCwd = join(acceptanceRoot, "unrelated-cwd");
  mkdirSync(unrelatedCwd, { recursive: true });

  const relocatedManifest = JSON.parse(readFileSync(join(relocated, "hostdeck-package.json"), "utf8"));
  makeReadOnly(relocated, new Set(relocatedManifest.executableFiles));
  runChild(
    "read-only relocated verifier",
    [join(relocated, "verify.mjs"), relocated],
    unrelatedCwd
  );
  runChild(
    "read-only relocated runtime smoke",
    [smokeScript, relocated, "--read-only"],
    unrelatedCwd
  );
  verifyProductionPackage(relocated);

  makeWritable(relocated);
  runRuntimeMismatchProbe(relocated, unrelatedCwd);
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing manifest field",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      const original = readFileSync(path);
      const value = JSON.parse(original.toString("utf8"));
      delete value.codex;
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      return () => writeFileSync(path, original);
    },
    /manifest fields are invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "modified owned output",
    () => {
      const path = join(relocated, "dist", "index.js");
      const original = readFileSync(path);
      appendFileSync(path, "\n// integrity drift\n");
      return () => writeFileSync(path, original);
    },
    /owned output identity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "absolute escaping symlink",
    () => {
      const path = join(relocated, "escape-link");
      symlinkSync(tmpdir(), path, "dir");
      return () => rmSync(path, { force: true });
    },
    /symlink is absolute/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing native module",
    () => {
      const native = join(relocated, relocatedManifest.nativeModules[0].path);
      const missing = `${native}.missing`;
      renameSync(native, missing);
      return () => renameSync(missing, native);
    },
    /mode is invalid|missing|identity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "corrupt native module",
    () => {
      const native = join(relocated, relocatedManifest.nativeModules[1].path);
      const original = readFileSync(native);
      const corrupt = Buffer.from(original);
      corrupt[0] ^= 0xff;
      writeFileSync(native, corrupt, { mode: 0o755 });
      return () => {
        writeFileSync(native, original);
        chmodSync(native, 0o755);
      };
    },
    /identity|integrity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing production dependency",
    () => {
      const dependency = join(relocated, "node_modules", "qrcode");
      const missing = `${dependency}.missing`;
      renameSync(dependency, missing);
      return () => renameSync(missing, dependency);
    },
    /identity|missing/iu
  );
  verifyProductionPackage(relocated);

  console.log(
    `HostDeck package acceptance passed: two deterministic builds, ${second.entryCount} entries, relocated read-only runtime, runtime/config/static/integrity rejection.`
  );
} finally {
  if (acceptanceRoot !== null) {
    makeWritable(acceptanceRoot);
    rmSync(acceptanceRoot, { force: true, recursive: true });
  }
}

function runMutationProbe(root, cwd, label, mutate, expected) {
  const restore = mutate();
  try {
    const result = runChild(label, [join(root, "verify.mjs"), root], cwd, true);
    assert.match(`${result.stdout}\n${result.stderr}`, expected, `${label} must fail at its owning boundary`);
  } finally {
    restore();
  }
  verifyProductionPackage(root);
}

function runRuntimeMismatchProbe(root, cwd) {
  const script = `
    import { pathToFileURL } from "node:url";
    const [modulePath, packageRoot] = process.argv.slice(1);
    const verifier = await import(pathToFileURL(modulePath).href);
    const current = verifier.currentRuntimeIdentity();
    const mismatches = [
      ["node", "0.0.0"],
      ["platform", "unsupported"],
      ["architecture", "unsupported"],
      ["nodeAbi", "0"]
    ];
    for (const [key, value] of mismatches) {
      try {
        verifier.verifyProductionPackage(packageRoot, { runtime: { ...current, [key]: value } });
        console.error("runtime " + key + " mismatch was accepted");
        process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Current runtime " + key)) throw error;
      }
    }
    console.log("all runtime mismatches rejected");
  `;
  const result = runChild(
    "runtime mismatch",
    ["--input-type=module", "--eval", script, join(root, "verify.mjs"), root],
    cwd
  );
  assert.match(result.stdout, /all runtime mismatches rejected/u);
}

function runChild(label, args, cwd, expectFailure = false) {
  const environment = {
    ...process.env,
    HOME: join(acceptanceRoot, "home"),
    XDG_CONFIG_HOME: join(acceptanceRoot, "xdg-config"),
    XDG_RUNTIME_DIR: join(acceptanceRoot, "xdg-runtime"),
    XDG_STATE_HOME: join(acceptanceRoot, "xdg-state")
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.TS_NODE_PROJECT;
  delete environment.TS_NODE_TRANSPILE_ONLY;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000
  });
  if (result.error !== undefined) throw new Error(`${label} could not run.`, { cause: result.error });
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(
      `${label} ${expectFailure ? "unexpectedly passed" : "failed"}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  return result;
}

function makeReadOnly(root, executables) {
  const directories = [];
  visit(root, (path, stats) => {
    if (stats.isDirectory()) directories.push(path);
    else if (stats.isFile()) {
      const relativePath = portable(relative(root, path));
      chmodSync(path, executables.has(relativePath) ? 0o555 : 0o444);
    }
  });
  directories.sort((left, right) => right.length - left.length);
  for (const path of directories) chmodSync(path, 0o555);
}

function makeWritable(root) {
  const stats = lstatOrNull(root);
  if (stats === null || stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(root, 0o755);
    for (const entry of readdirSync(root)) makeWritable(join(root, entry));
  } else if (stats.isFile()) {
    chmodSync(root, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

function visit(root, inspect) {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) return;
  inspect(root, stats);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(root)) visit(join(root, entry), inspect);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function portable(path) {
  return path.split(sep).join("/");
}
