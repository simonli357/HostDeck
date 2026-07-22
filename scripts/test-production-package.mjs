import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
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
import {
  computeManifestSha256,
  verifyProductionPackage
} from "./verify-production-package.mjs";

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
  runServiceHostImport(relocated, relocatedManifest, unrelatedCwd);
  runExecutableInvocationMatrix(relocated, relocatedManifest, unrelatedCwd);
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
    "missing CLI bin metadata",
    () => mutateJson(join(relocated, "package.json"), (value) => delete value.bin),
    /package\.json fields are invalid|runtime manifest is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "source-targeted CLI bin metadata",
    () =>
      mutateJson(join(relocated, "package.json"), (value) => {
        value.bin = { codexdeck: "./src/shell.ts" };
      }),
    /runtime manifest is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "multiply declared CLI bins",
    () =>
      mutateJson(join(relocated, "package.json"), (value) => {
        value.bin = {
          codexdeck: "./dist/shell.js",
          unexpected: "./dist/index.js"
        };
      }),
    /runtime manifest is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "non-executable CLI command",
    () => {
      const path = join(relocated, relocatedManifest.command.path);
      chmodSync(path, 0o644);
      return () => chmodSync(path, 0o755);
    },
    /command target is missing or not executable|file mode is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "modified CLI shebang",
    () => {
      const path = join(relocated, relocatedManifest.command.path);
      const original = readFileSync(path);
      const changed = Buffer.from(original);
      changed[2] = "x".charCodeAt(0);
      writeFileSync(path, changed, { mode: 0o755 });
      return () => {
        writeFileSync(path, original);
        chmodSync(path, 0o755);
      };
    },
    /command target identity is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "escaping CLI command descriptor",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.command.path = "../shell.js";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /command descriptor is inconsistent|command path/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "executable service-host module",
    () => {
      const path = join(relocated, relocatedManifest.serviceHost.path);
      chmodSync(path, 0o755);
      return () => chmodSync(path, 0o644);
    },
    /service-host module is missing or executable|file mode is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "modified service-host module",
    () => {
      const path = join(relocated, relocatedManifest.serviceHost.path);
      const original = readFileSync(path);
      appendFileSync(path, "\n// service-host drift\n");
      return () => writeFileSync(path, original);
    },
    /service-host module identity|owned output identity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "escaping service-host descriptor",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.serviceHost.path = "../service-host.js";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /service-host descriptor is inconsistent|service-host path/iu
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

function runServiceHostImport(root, manifest, cwd) {
  const script = `
    import { pathToFileURL } from "node:url";
    await import(pathToFileURL(process.argv[1]).href);
    console.log("service-host import remained inert");
  `;
  const result = runChild(
    "service-host inert import",
    [
      "--input-type=module",
      "--eval",
      script,
      join(root, manifest.serviceHost.path)
    ],
    cwd
  );
  assert.equal(result.stdout, "service-host import remained inert\n");
  assert.equal(result.stderr, "");
}

function runExecutableInvocationMatrix(root, manifest, unrelatedCwd) {
  const command = join(root, manifest.command.path);
  assertHelpResult(
    runChild("Node-path command help", [command, "--help"], unrelatedCwd)
  );
  assertVersionResult(
    runCommand("direct executable version", command, ["version"], unrelatedCwd),
    manifest.packageVersion
  );

  const managerProject = join(acceptanceRoot, "package-manager-install");
  mkdirSync(managerProject, { recursive: true });
  writeFileSync(
    join(managerProject, "package.json"),
    `${JSON.stringify({ name: "hostdeck-package-manager-acceptance", private: true, version: "1.0.0" }, null, 2)}\n`
  );
  runPnpm(
    "package-manager link install",
    ["add", "--offline", "--ignore-scripts", root],
    managerProject
  );
  assertVersionResult(
    runPnpm(
      "package-manager command version",
      ["exec", "codexdeck", "--version"],
      managerProject
    ),
    manifest.packageVersion
  );

  const archive = join(acceptanceRoot, "hostdeck-runtime.tgz");
  runCommand(
    "runtime archive creation",
    "tar",
    ["-czf", archive, "-C", dirname(root), "hostdeck"],
    unrelatedCwd
  );
  const packedInstallRoot = join(acceptanceRoot, "packed-install");
  mkdirSync(packedInstallRoot, { recursive: true });
  runCommand(
    "runtime archive extraction",
    "tar",
    ["-xzf", archive, "-C", packedInstallRoot],
    unrelatedCwd
  );
  const packedPackage = join(packedInstallRoot, "hostdeck");
  const packedManifest = JSON.parse(
    readFileSync(join(packedPackage, "hostdeck-package.json"), "utf8")
  );
  makeReadOnly(packedPackage, new Set(packedManifest.executableFiles));
  verifyProductionPackage(packedPackage);
  assertHelpResult(
    runCommand(
      "packed runtime executable help",
      join(packedPackage, packedManifest.command.path),
      ["help"],
      unrelatedCwd
    )
  );

  const globalPrefix = join(acceptanceRoot, "global-prefix");
  const globalPackage = join(
    globalPrefix,
    "lib",
    "node_modules",
    "@hostdeck",
    "cli"
  );
  const globalBin = join(globalPrefix, "bin", "codexdeck");
  mkdirSync(dirname(globalPackage), { recursive: true });
  mkdirSync(dirname(globalBin), { recursive: true });
  symlinkSync(relative(dirname(globalPackage), packedPackage), globalPackage, "dir");
  symlinkSync(
    relative(dirname(globalBin), join(globalPackage, packedManifest.command.path)),
    globalBin,
    "file"
  );
  assertVersionResult(
    runCommand(
      "temporary global-style command version",
      globalBin,
      ["--version"],
      unrelatedCwd
    ),
    manifest.packageVersion
  );

  const service = runCommand(
    "reserved service command",
    command,
    ["service", "start"],
    unrelatedCwd,
    true
  );
  assert.equal(service.status, 70);
  assert.match(service.stderr, /capability_unavailable/u);
  const missingConfig = join(acceptanceRoot, "private-missing-config.json");
  const config = runCommand(
    "missing config command",
    command,
    ["--config", missingConfig, "status"],
    unrelatedCwd,
    true
  );
  assert.equal(config.status, 78);
  assert.doesNotMatch(config.stderr, /private-missing-config/u);

  const serveRoot = join(acceptanceRoot, "serve-preflight");
  const serve = runCommand(
    "missing runtime directory serve command",
    command,
    ["serve"],
    unrelatedCwd,
    true,
    {
      HOME: join(serveRoot, "home"),
      XDG_CONFIG_HOME: join(serveRoot, "config"),
      XDG_RUNTIME_DIR: "",
      XDG_STATE_HOME: join(serveRoot, "state")
    }
  );
  assert.equal(serve.status, 78);
  assert.match(serve.stderr, /XDG_RUNTIME_DIR is required/u);
  assert.equal(existsSync(serveRoot), false);
}

function assertHelpResult(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Usage:\n {2}codexdeck serve/mu);
  assert.doesNotMatch(result.stdout, /hostdeck-package-acceptance-/u);
}

function assertVersionResult(result, version) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `codexdeck ${version}\n`);
}

function mutateJson(path, change) {
  const original = readFileSync(path);
  const value = JSON.parse(original.toString("utf8"));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return () => writeFileSync(path, original);
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
  return runCommand(label, process.execPath, args, cwd, expectFailure);
}

function runPnpm(label, args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return typeof npmExecPath === "string" && existsSync(npmExecPath)
    ? runCommand(label, process.execPath, [npmExecPath, ...args], cwd)
    : runCommand(label, "pnpm", args, cwd);
}

function runCommand(
  label,
  command,
  args,
  cwd,
  expectFailure = false,
  environmentOverrides = {}
) {
  const environment = {
    ...process.env,
    HOME: join(acceptanceRoot, "home"),
    XDG_CONFIG_HOME: join(acceptanceRoot, "xdg-config"),
    XDG_RUNTIME_DIR: join(acceptanceRoot, "xdg-runtime"),
    XDG_STATE_HOME: join(acceptanceRoot, "xdg-state"),
    ...environmentOverrides
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.TS_NODE_PROJECT;
  delete environment.TS_NODE_TRANSPILE_ONLY;
  const result = spawnSync(command, args, {
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
