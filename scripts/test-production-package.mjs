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
  productionLinuxLauncherContent,
  productionPackageManifestSchemaVersion,
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
  const firstWebManifestText = readFileSync(
    join(outputRoot, firstManifest.web.manifestPath),
    "utf8"
  );
  assert.equal(firstManifest.schemaVersion, productionPackageManifestSchemaVersion);
  assert.deepEqual(firstManifest.artifact, { kind: "native_tree" });
  assert.deepEqual(firstManifest.target, {
    architecture: "x64",
    id: "linux-x64",
    lifecycle: "systemd_user",
    platform: "linux",
    publicPackageKind: "linux_archive"
  });
  assert.equal(firstManifest.runtime.delivery, "bundled");
  assert.equal(firstManifest.runtime.bundle.path, "runtime/bin/node");
  assert.ok(firstManifest.runtime.bundle.size > 1_000_000);
  assert.match(firstManifest.runtime.bundle.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(lstatSync(join(outputRoot, "runtime", "bin", "node")).mode & 0o777, 0o755);
  assert.ok(lstatSync(join(outputRoot, "runtime", "LICENSE")).size > 0);
  assert.equal(
    readFileSync(join(outputRoot, firstManifest.command.path), "utf8"),
    productionLinuxLauncherContent
  );
  assert.equal(firstManifest.brokerHost.path, "dist/broker-host.js");
  assert.equal(firstManifest.serviceHost.path, "dist/service-host.js");
  assert.equal(firstManifest.source.commit, first.sourceCommit);
  assert.match(firstManifest.source.commit, /^[a-f0-9]{40}$/u);
  assert.deepEqual(
    firstManifest.nativeModules.map(({ nodeAbi, package: name, target, version }) => ({
      name,
      nodeAbi,
      target,
      version
    })),
    [
      { name: "better-sqlite3", nodeAbi: "127", target: "linux-x64", version: "12.11.1" },
      { name: "fs-native-extensions", nodeAbi: "127", target: "linux-x64", version: "1.3.4" },
      { name: "koffi", nodeAbi: "127", target: "linux-x64", version: "3.1.4" }
    ]
  );
  assert.equal(firstManifest.web.sha256, first.webSha256);
  assert.equal(firstManifest.web.fileCount, first.webFileCount);
  assert.equal(firstManifest.web.bytes, first.webBytes);
  assert.deepEqual(firstManifest.deferrals, []);

  const second = buildProductionPackage({ repositoryRoot });
  const secondManifestText = readFileSync(join(outputRoot, "hostdeck-package.json"), "utf8");
  const secondManifest = JSON.parse(secondManifestText);
  const secondWebManifestText = readFileSync(
    join(outputRoot, secondManifest.web.manifestPath),
    "utf8"
  );
  assert.deepEqual(second, first, "two unchanged builds must return identical identities");
  assert.equal(secondManifestText, firstManifestText, "two unchanged builds must emit the same manifest bytes");
  assert.equal(
    secondWebManifestText,
    firstWebManifestText,
    "two unchanged builds must emit the same runtime web-manifest bytes"
  );
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
  copyFileSync(
    join(scriptDirectory, "production-web-smoke-support.mjs"),
    join(acceptanceRoot, "production-web-smoke-support.mjs")
  );
  copyFileSync(
    join(scriptDirectory, "verify-production-package.mjs"),
    join(acceptanceRoot, "verify-production-package.mjs")
  );
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
  runProcessHostImports(relocated, relocatedManifest, unrelatedCwd);
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
    "unknown package artifact",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.artifact.kind = "unknown";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /artifact kind is unsupported/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "mixed package target",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.target.platform = "win32";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /target platform is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "mixed runtime delivery",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.runtime.delivery = "host_provided";
        value.runtime.bundle = null;
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /runtime delivery is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "invalid source commit",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.source.commit = "A".repeat(40);
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /source commit is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "mixed command kind",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.command.kind = "native_executable";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /command descriptor is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "mixed service lifecycle",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.serviceHost.lifecycle = "windows_user_agent";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /service-host descriptor is inconsistent/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "mixed native module ABI",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.nativeModules[0].nodeAbi = "126";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /native-module order or identity is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing root web descriptor",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        delete value.web;
      });
    },
    /manifest fields are invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "changed root web descriptor",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.web.sha256 = "0".repeat(64);
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /web descriptor (?:identity|sha256)|production web content/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing runtime web manifest",
    () => temporarilyRename(join(relocated, relocatedManifest.web.manifestPath)),
    /web manifest.*missing|web root inventory/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "runtime web schema drift",
    () =>
      mutateJson(join(relocated, relocatedManifest.web.manifestPath), (value) => {
        value.schemaVersion += 1;
      }),
    /web-manifest schema/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "runtime web package-version drift",
    () =>
      mutateJson(join(relocated, relocatedManifest.web.manifestPath), (value) => {
        value.packageVersion = "9.9.9";
      }),
    /web package version/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "runtime web route drift",
    () =>
      mutateJson(join(relocated, relocatedManifest.web.manifestPath), (value) => {
        value.browserRoutes = ["/"];
      }),
    /web browser routes|web manifest.*identity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "runtime web aggregate-count drift",
    () =>
      mutateJson(join(relocated, relocatedManifest.web.manifestPath), (value) => {
        value.content.count += 1;
      }),
    /web content count/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "runtime web descriptor order drift",
    () =>
      mutateJson(join(relocated, relocatedManifest.web.manifestPath), (value) => {
        value.assets.reverse();
      }),
    /web asset inventory must be sorted/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "changed production index",
    () => mutateFile(join(relocated, "web", "index.html"), (content) =>
      Buffer.from(content.toString("utf8").replace("<div id=\"root\"></div>", "<div id=\"root\">drift</div>"))
    ),
    /web file identity|web descriptor identity|package content/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "unsafe production index mode",
    () => mutateMode(join(relocated, "web", "index.html"), 0o664, 0o644),
    /file mode is invalid/iu
  );
  const runtimeWebManifest = JSON.parse(
    readFileSync(join(relocated, relocatedManifest.web.manifestPath), "utf8")
  );
  const selectedWebAsset = runtimeWebManifest.assets[0];
  assert.ok(selectedWebAsset !== undefined);
  const selectedWebAssetPath = join(relocated, "web", ...selectedWebAsset.path.split("/"));
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "changed production asset",
    () => mutateFile(selectedWebAssetPath, (content) => Buffer.concat([content, Buffer.from("\n")])),
    /web file identity|web descriptor identity|package content/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "unsafe production asset mode",
    () => mutateMode(selectedWebAssetPath, 0o666, 0o644),
    /file mode is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "missing production asset",
    () => temporarilyRename(selectedWebAssetPath),
    /web file inventory|missing|unreadable/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "extra production asset",
    () => {
      const path = join(relocated, "web", "assets", "late-12345678.js");
      writeFileSync(path, "export {};\n", { mode: 0o644 });
      return () => rmSync(path, { force: true });
    },
    /web file inventory|web descriptor identity|package content/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "reintroduced dependency source map",
    () => {
      const path = join(relocated, "node_modules", "late-runtime.js.map");
      writeFileSync(path, "{}\n", { mode: 0o644 });
      return () => rmSync(path, { force: true });
    },
    /forbidden source map/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "reintroduced environment file",
    () => {
      const path = join(relocated, ".env.production");
      writeFileSync(path, "PRIVATE=value\n", { mode: 0o644 });
      return () => rmSync(path, { force: true });
    },
    /forbidden environment file/iu
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
    "missing bundled Node runtime",
    () => temporarilyRename(join(relocated, relocatedManifest.runtime.bundle.path)),
    /bundled runtime executable is missing|file inventory/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "corrupt bundled Node runtime",
    () =>
      mutateFile(join(relocated, relocatedManifest.runtime.bundle.path), (content) => {
        const changed = Buffer.from(content);
        changed[0] ^= 0xff;
        return changed;
      }),
    /bundled runtime executable integrity|owned output identity|package content/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "non-executable bundled Node runtime",
    () =>
      mutateMode(
        join(relocated, relocatedManifest.runtime.bundle.path),
        0o644,
        0o755
      ),
    /bundled runtime executable is missing|file mode is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "executable broker-host module",
    () => {
      const path = join(relocated, relocatedManifest.brokerHost.path);
      chmodSync(path, 0o755);
      return () => chmodSync(path, 0o644);
    },
    /broker-host module is missing or executable|file mode is invalid/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "modified broker-host module",
    () => {
      const path = join(relocated, relocatedManifest.brokerHost.path);
      const original = readFileSync(path);
      appendFileSync(path, "\n// broker-host drift\n");
      return () => writeFileSync(path, original);
    },
    /broker-host module identity|owned output identity/iu
  );
  runMutationProbe(
    relocated,
    unrelatedCwd,
    "escaping broker-host descriptor",
    () => {
      const path = join(relocated, "hostdeck-package.json");
      return mutateJson(path, (value) => {
        value.brokerHost.path = "../broker-host.js";
        value.manifestSha256 = computeManifestSha256(value);
      });
    },
    /broker-host descriptor is inconsistent|broker-host path/iu
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
    `HostDeck package acceptance passed: two deterministic builds, ${second.entryCount} entries, ${second.webFileCount} web files (${second.webBytes} bytes, sha256:${second.webSha256}), relocated read-only runtime, runtime/config/static/web-integrity rejection.`
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

function runProcessHostImports(root, manifest, cwd) {
  const script = `
    import { pathToFileURL } from "node:url";
    for (const modulePath of process.argv.slice(1)) {
      await import(pathToFileURL(modulePath).href);
    }
    console.log("process-host imports remained inert");
  `;
  const result = runCommand(
    "process-host inert imports",
    join(root, manifest.runtime.bundle.path),
    [
      "--input-type=module",
      "--eval",
      script,
      join(root, manifest.brokerHost.path),
      join(root, manifest.serviceHost.path)
    ],
    cwd,
    false,
    { PATH: "" }
  );
  assert.equal(result.stdout, "process-host imports remained inert\n");
  assert.equal(result.stderr, "");
}

function runExecutableInvocationMatrix(root, manifest, unrelatedCwd) {
  const command = join(root, manifest.command.path);
  assertHelpResult(
    runCommand(
      "bundled-runtime command help",
      command,
      ["--help"],
      unrelatedCwd,
      false,
      { PATH: "" }
    )
  );
  assertVersionResult(
    runCommand(
      "direct executable version",
      command,
      ["version"],
      unrelatedCwd,
      false,
      { PATH: "" }
    ),
    manifest.packageVersion
  );
  const bundledNodeVersion = runCommand(
    "bundled Node version",
    join(root, manifest.runtime.bundle.path),
    ["--version"],
    unrelatedCwd,
    false,
    { PATH: "" }
  );
  assert.equal(bundledNodeVersion.stdout, `v${manifest.runtime.node}\n`);
  assert.equal(bundledNodeVersion.stderr, "");
  const canProbeUninstall = assertUninstallResult(
    runUncheckedCommand(
      "read-only relocated service uninstall",
      command,
      ["service", "uninstall", "--json"],
      unrelatedCwd
    ),
    "read-only relocated service uninstall"
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
  if (canProbeUninstall) {
    assertUninstallResult(
      runPnpm(
        "package-manager service uninstall",
        ["exec", "codexdeck", "service", "uninstall", "--json"],
        managerProject
      ),
      "package-manager service uninstall"
    );
  }

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
  if (canProbeUninstall) {
    assertUninstallResult(
      runCommand(
        "packed runtime service uninstall",
        join(packedPackage, packedManifest.command.path),
        ["service", "uninstall", "--json"],
        unrelatedCwd
      ),
      "packed runtime service uninstall"
    );
  }

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
  if (canProbeUninstall) {
    assertUninstallResult(
      runCommand(
        "global-style service uninstall",
        globalBin,
        ["service", "uninstall", "--json"],
        unrelatedCwd
      ),
      "global-style service uninstall"
    );
  }

  const installedCommand = join(
    acceptanceRoot,
    "installed-command",
    "bin",
    "codexdeck"
  );
  mkdirSync(dirname(installedCommand), { recursive: true });
  symlinkSync(relative(dirname(installedCommand), command), installedCommand);
  if (canProbeUninstall) {
    assertUninstallResult(
      runCommand(
        "installed-command service uninstall",
        installedCommand,
        ["service", "uninstall", "--json"],
        unrelatedCwd
      ),
      "installed-command service uninstall"
    );
  }
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

function assertUninstallResult(result, label) {
  if (result.status === 70) {
    assert.equal(result.stdout, "", `${label} conflict must not write stdout`);
    assert.equal(
      result.stderr,
      "HostDeck CLI error (operation_conflict): HostDeck service ownership could not be proven for safe uninstall.\n",
      `${label} must expose only the exact foreign-installation refusal`
    );
    return false;
  }
  assert.equal(result.status, 0, `${label} must succeed`);
  assert.equal(result.stderr, "", `${label} must not write stderr`);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      action: parsed.action,
      api_state: parsed.api_state,
      changed: parsed.changed,
      enabled: parsed.enabled,
      install_state: parsed.install_state,
      package_version: parsed.package_version,
      release_id: parsed.release_id,
      rollback: parsed.rollback,
      codex: parsed.units?.codex,
      hostdeck: parsed.units?.hostdeck
    },
    {
      action: "uninstall",
      api_state: "not_probed",
      changed: false,
      enabled: false,
      install_state: "not_installed",
      package_version: null,
      release_id: null,
      rollback: "not_required",
      codex: {
        active_state: "inactive",
        load_state: "not-found",
        main_pid: 0,
        need_daemon_reload: false,
        sub_state: "dead",
        unit_file_state: ""
      },
      hostdeck: {
        active_state: "inactive",
        load_state: "not-found",
        main_pid: 0,
        need_daemon_reload: false,
        sub_state: "dead",
        unit_file_state: ""
      }
    },
    `${label} result must be exact`
  );
  return true;
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

function mutateFile(path, change) {
  const original = readFileSync(path);
  const mode = lstatSync(path).mode & 0o777;
  writeFileSync(path, change(original), { mode });
  return () => {
    writeFileSync(path, original);
    chmodSync(path, mode);
  };
}

function mutateMode(path, changedMode, originalMode) {
  chmodSync(path, changedMode);
  return () => chmodSync(path, originalMode);
}

function temporarilyRename(path) {
  const missing = `${path}.missing`;
  renameSync(path, missing);
  return () => renameSync(missing, path);
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
  const result = runUncheckedCommand(
    label,
    command,
    args,
    cwd,
    environmentOverrides
  );
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(
      `${label} ${expectFailure ? "unexpectedly passed" : "failed"}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  return result;
}

function runUncheckedCommand(
  label,
  command,
  args,
  cwd,
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
