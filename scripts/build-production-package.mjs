import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSelectedRuntimeBoundary } from "./check-selected-runtime-boundary.mjs";
import {
  computeFileIdentity,
  computeManifestSha256,
  computeOwnedOutputIdentity,
  inspectProductionPackageTree,
  productionPackageManifestName,
  productionPackageVerifierName,
  sha256Hex,
  verifyProductionPackage
} from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "..");
const packageNames = ["core", "contracts", "codex-adapter", "storage", "server", "cli"];
const expectedExternalModules = [
  "@fastify/sse",
  "@fastify/static",
  "better-sqlite3",
  "cookie",
  "fastify",
  "fs-ext",
  "qrcode",
  "ws",
  "zod"
];
const downstreamDeferrals = [
  "IFC-V1-053",
  "IFC-V1-054",
  "IFC-V1-055",
  "IFC-V1-056",
  "IFC-V1-057",
  "IFC-V1-058"
];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function selectedProductionSources(repositoryRoot = defaultRepositoryRoot) {
  const result = validateSelectedRuntimeBoundary(repositoryRoot);
  if (result.failures.length > 0) {
    throw new Error(`Selected runtime boundary failed:\n- ${result.failures.join("\n- ")}`);
  }
  const sources = result.closureFiles.filter((path) => !path.startsWith("packages/web/"));
  if (sources.length !== 600) {
    throw new Error(`Selected server/CLI closure contains ${sources.length} sources; expected exactly 600.`);
  }
  const selectedPackages = new Set(sources.map((path) => path.split("/")[1]));
  if (selectedPackages.size !== packageNames.length || packageNames.some((name) => !selectedPackages.has(name))) {
    throw new Error("Selected server/CLI closure package roots are inconsistent.");
  }
  const external = result.externalModules.filter((name) => !name.startsWith("node:")).sort();
  if (!sameArray(external, expectedExternalModules)) {
    throw new Error(`Selected external runtime modules changed: ${external.join(", ")}.`);
  }
  return Object.freeze([...sources]);
}

export function createRuntimePackageManifest(sourceManifest, packageVersion, nodeVersion) {
  if (sourceManifest === null || typeof sourceManifest !== "object" || Array.isArray(sourceManifest)) {
    throw new TypeError("Source package manifest must be an object.");
  }
  if (typeof sourceManifest.name !== "string" || !sourceManifest.name.startsWith("@hostdeck/")) {
    throw new TypeError("Source package manifest name is invalid.");
  }
  const dependencies = {};
  for (const [name, rawVersion] of Object.entries(sourceManifest.dependencies ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const version = name.startsWith("@hostdeck/") ? packageVersion : rawVersion;
    if (typeof version !== "string" || !exactVersionPattern.test(version)) {
      throw new TypeError(`${sourceManifest.name} dependency ${name} is not pinned exactly.`);
    }
    dependencies[name] = version;
  }
  const manifest = {
    name: sourceManifest.name,
    version: packageVersion,
    private: true,
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      }
    },
    engines: { node: nodeVersion }
  };
  if (Object.keys(dependencies).length > 0) manifest.dependencies = dependencies;
  return manifest;
}

export function buildProductionPackage(options = {}) {
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? defaultRepositoryRoot));
  const outputRoot = join(repositoryRoot, "dist", "hostdeck");
  const rootManifest = readJson(join(repositoryRoot, "package.json"));
  const runtime = assertBuildRuntime(repositoryRoot, rootManifest);
  const sources = selectedProductionSources(repositoryRoot);
  const sourceIdentity = computeFileIdentity(
    sources.map((path) => ({ content: readFileSync(join(repositoryRoot, path)), path }))
  );
  const sourceCounts = countSourcesByPackage(sources);
  const codex = readCodexBindingIdentity(repositoryRoot);
  const packageVersion = parseExactVersion(rootManifest.version, "Root package version");
  const distRoot = join(repositoryRoot, "dist");
  mkdirSync(distRoot, { mode: 0o755, recursive: true });
  const stagingRoot = mkdtempSync(join(distRoot, ".hostdeck-build-"));
  const emitRoot = join(stagingRoot, "emit");
  const deployRoot = join(stagingRoot, "deploy");
  const packageRoot = join(stagingRoot, "package");
  try {
    compileSelectedSources(repositoryRoot, stagingRoot, emitRoot, sources);
    assertExactCompilerOutput(emitRoot, sources);
    deployProductionDependencies(repositoryRoot, deployRoot);
    cpSync(deployRoot, packageRoot, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true
    });

    const descriptors = installCompiledPackages({
      emitRoot,
      nodeVersion: runtime.node,
      packageRoot,
      packageVersion,
      repositoryRoot,
      sourceCounts
    });
    removePackageManagerMetadata(packageRoot);
    pruneNativeBuildIntermediates(packageRoot);
    copyFileSync(
      join(scriptDirectory, "verify-production-package.mjs"),
      join(packageRoot, productionPackageVerifierName)
    );

    const executableFiles = collectExecutableFiles(packageRoot);
    normalizePackageModes(packageRoot, new Set(executableFiles));
    const nativeModules = collectRequiredNativeModules(packageRoot, executableFiles);
    const ownedOutput = computeOwnedOutputIdentity(packageRoot, descriptors);
    const content = inspectProductionPackageTree(packageRoot, executableFiles);
    const manifest = {
      schemaVersion: 1,
      name: "hostdeck-production-package",
      packageVersion,
      packageManager: `pnpm@${runtime.pnpm}`,
      nativeBuildPolicy: "canonical-runtime-binary-only",
      runtime,
      codex,
      source: { count: sourceIdentity.count, sha256: sourceIdentity.sha256 },
      output: { count: ownedOutput.count, sha256: ownedOutput.sha256 },
      content,
      packages: descriptors,
      nativeModules,
      executableFiles,
      deferrals: downstreamDeferrals
    };
    manifest.manifestSha256 = computeManifestSha256(manifest);
    writeJson(join(packageRoot, productionPackageManifestName), manifest);
    chmodSync(join(packageRoot, productionPackageManifestName), 0o644);

    scanForbiddenBuildReferences(packageRoot, [repositoryRoot, stagingRoot], homedir());
    const verification = verifyProductionPackage(packageRoot);
    publishCompletedPackage(packageRoot, outputRoot);
    return Object.freeze({
      contentSha256: verification.contentSha256,
      entryCount: verification.entryCount,
      outputCount: verification.outputCount,
      outputRoot,
      packageVersion,
      sourceCount: sources.length
    });
  } finally {
    removeTree(stagingRoot);
  }
}

function assertBuildRuntime(repositoryRoot, rootManifest) {
  const expectedNode = parseExactVersion(rootManifest.engines?.node, "Required Node version");
  const expectedPnpm = parseExactVersion(rootManifest.engines?.pnpm, "Required pnpm version");
  if (process.versions.node !== expectedNode) {
    throw new Error(`Build requires Node ${expectedNode}; current runtime is ${process.versions.node}.`);
  }
  if (process.platform !== "linux" || process.arch !== "x64" || process.versions.modules !== "127") {
    throw new Error("Build requires the reviewed Linux x64 Node ABI 127 target.");
  }
  if (rootManifest.packageManager !== `pnpm@${expectedPnpm}`) {
    throw new Error("Root package-manager and pnpm engine identities differ.");
  }
  const observedPnpm = runPnpm(repositoryRoot, ["--version"]).stdout.trim();
  if (observedPnpm !== expectedPnpm) {
    throw new Error(`Build requires pnpm ${expectedPnpm}; current pnpm is ${observedPnpm || "unknown"}.`);
  }
  return Object.freeze({
    architecture: process.arch,
    node: process.versions.node,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    pnpm: observedPnpm
  });
}

function compileSelectedSources(repositoryRoot, stagingRoot, emitRoot, sources) {
  const configPath = join(stagingRoot, "tsconfig.production.json");
  writeJson(configPath, {
    extends: join(repositoryRoot, "tsconfig.base.json"),
    compilerOptions: {
      declaration: true,
      declarationMap: false,
      incremental: false,
      inlineSourceMap: false,
      inlineSources: false,
      noEmit: false,
      noEmitOnError: true,
      outDir: emitRoot,
      rootDir: repositoryRoot,
      sourceMap: false,
      types: ["node"]
    },
    files: sources.map((path) => join(repositoryRoot, path))
  });
  runChecked(
    process.execPath,
    [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "--project", configPath, "--pretty", "false"],
    repositoryRoot,
    "TypeScript production emit"
  );
}

function assertExactCompilerOutput(emitRoot, sources) {
  const expected = [];
  for (const source of sources) {
    const base = source.slice(0, -extname(source).length);
    expected.push(`${base}.d.ts`, `${base}.js`);
  }
  expected.sort();
  const actual = listRegularFiles(emitRoot).map((path) => portable(relative(emitRoot, path))).sort();
  if (!sameArray(actual, expected)) {
    const missing = expected.filter((path) => !actual.includes(path)).slice(0, 10);
    const extra = actual.filter((path) => !expected.includes(path)).slice(0, 10);
    throw new Error(`Compiler output drifted. Missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`);
  }
}

function deployProductionDependencies(repositoryRoot, deployRoot) {
  runPnpm(repositoryRoot, [
    "--offline",
    "--frozen-lockfile",
    "--filter",
    "@hostdeck/cli",
    "deploy",
    "--legacy",
    "--prod",
    deployRoot
  ], "Offline production dependency deploy");
  if (!existsSync(join(deployRoot, "node_modules", ".pnpm"))) {
    throw new Error("Offline production dependency deploy did not create the expected pnpm layout.");
  }
}

function pruneNativeBuildIntermediates(root) {
  const fsExtRoot = realpathSync(join(root, "node_modules", ".pnpm", "node_modules", "fs-ext"));
  if (!isInside(root, fsExtRoot)) throw new Error("fs-ext package root escapes the staging tree.");
  const buildRoot = join(fsExtRoot, "build");
  const canonicalNative = join(buildRoot, "Release", "fs_ext.node");
  const nativeContent = readFileSync(canonicalNative);
  rmSync(buildRoot, { force: true, recursive: true });
  mkdirSync(join(buildRoot, "Release"), { mode: 0o755, recursive: true });
  writeFileSync(canonicalNative, nativeContent, { mode: 0o755 });
}

function installCompiledPackages(input) {
  const roots = new Map();
  roots.set("cli", input.packageRoot);
  for (const name of packageNames.filter((candidate) => candidate !== "cli")) {
    const locator = join(input.packageRoot, "node_modules", ".pnpm", "node_modules", "@hostdeck", name);
    const packagePath = realpathSync(locator);
    if (!isInside(input.packageRoot, packagePath)) {
      throw new Error(`Deployed @hostdeck/${name} package root escapes the staging tree.`);
    }
    roots.set(name, packagePath);
  }

  const descriptors = [];
  for (const name of packageNames) {
    const target = roots.get(name);
    cleanOwnedPackageRoot(target);
    const emitted = join(input.emitRoot, "packages", name, "src");
    const output = join(target, "dist");
    cpSync(emitted, output, { dereference: false, errorOnExist: true, force: false, recursive: true });
    const sourceManifest = readJson(join(input.repositoryRoot, "packages", name, "package.json"));
    if (sourceManifest.version !== input.packageVersion) {
      throw new Error(`@hostdeck/${name} version differs from the root package version.`);
    }
    const runtimeManifest = createRuntimePackageManifest(
      sourceManifest,
      input.packageVersion,
      input.nodeVersion
    );
    writeJson(join(target, "package.json"), runtimeManifest);
    const logicalRoot = name === "cli" ? "." : `node_modules/@hostdeck/${name}`;
    const prefix = logicalRoot === "." ? "" : `${logicalRoot}/`;
    const outputCount = listRegularFiles(output).length;
    descriptors.push({
      name: `@hostdeck/${name}`,
      version: input.packageVersion,
      root: logicalRoot,
      entrypoint: `${prefix}dist/index.js`,
      types: `${prefix}dist/index.d.ts`,
      sourceCount: input.sourceCounts.get(name),
      outputCount,
      dependencies: runtimeManifest.dependencies ?? {}
    });
  }

  const hostDeckLinks = join(input.packageRoot, "node_modules", "@hostdeck");
  mkdirSync(hostDeckLinks, { recursive: true });
  for (const name of packageNames.filter((candidate) => candidate !== "cli")) {
    const link = join(hostDeckLinks, name);
    if (existsSync(link) || lstatOrNull(link)?.isSymbolicLink()) rmSync(link, { force: true, recursive: true });
    const target = roots.get(name);
    symlinkSync(portable(relative(dirname(link), target)), link, "dir");
  }
  return Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor)));
}

function cleanOwnedPackageRoot(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    rmSync(join(root, entry.name), { force: true, recursive: true });
  }
}

function removePackageManagerMetadata(root) {
  const paths = [
    join(root, "node_modules", ".modules.yaml"),
    join(root, "node_modules", ".pnpm", "lock.yaml"),
    join(root, "node_modules", ".pnpm", "node_modules", "@hostdeck", "cli")
  ];
  for (const path of paths) rmSync(path, { force: true, recursive: true });
  for (const path of listDirectories(root).filter((directory) => basename(directory) === ".bin")) {
    rmSync(path, { force: true, recursive: true });
  }
}

function collectExecutableFiles(root) {
  const executables = new Set();
  for (const path of listRegularFiles(root)) {
    const relativePath = portable(relative(root, path));
    if (path.endsWith(".node")) executables.add(relativePath);
    if (basename(path) !== "package.json") continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`Production dependency contains invalid package.json at ${relativePath}.`);
    }
    for (const target of declaredBinTargets(manifest.bin)) {
      const absoluteTarget = resolve(dirname(path), target);
      if (!isInside(root, absoluteTarget) || !lstatOrNull(absoluteTarget)?.isFile()) {
        throw new Error(`Production dependency bin target is missing or escaping at ${relativePath}.`);
      }
      executables.add(portable(relative(root, absoluteTarget)));
    }
  }
  return [...executables].sort();
}

function declaredBinTargets(bin) {
  if (bin === undefined) return [];
  if (typeof bin === "string") return [bin];
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    throw new TypeError("Production dependency bin metadata is invalid.");
  }
  const values = Object.values(bin);
  if (values.some((value) => typeof value !== "string")) {
    throw new TypeError("Production dependency bin target is invalid.");
  }
  return values;
}

function normalizePackageModes(root, executableFiles) {
  chmodSync(root, 0o755);
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        chmodSync(path, 0o755);
        visit(path);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Package contains unsupported filesystem entry ${portable(relative(root, path))}.`);
      const relativePath = portable(relative(root, path));
      chmodSync(path, executableFiles.has(relativePath) ? 0o755 : 0o644);
    }
  }
  visit(root);
}

function collectRequiredNativeModules(root, executableFiles) {
  const executableSet = new Set(executableFiles);
  const candidates = listRegularFiles(root).filter((path) => path.endsWith(".node"));
  const requirements = [
    ["better-sqlite3", "/better-sqlite3/build/Release/better_sqlite3.node"],
    ["fs-ext", "/fs-ext/build/Release/fs_ext.node"]
  ];
  return requirements.map(([packageName, suffix]) => {
    const matches = candidates.filter((path) => portable(path).endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(`${packageName} canonical native module count is ${matches.length}; expected one.`);
    }
    const path = matches[0];
    const relativePath = portable(relative(root, path));
    if (!executableSet.has(relativePath)) throw new Error(`${packageName} native module is not executable.`);
    const content = readFileSync(path);
    return Object.freeze({
      package: packageName,
      path: relativePath,
      sha256: sha256Hex(content),
      size: content.length
    });
  });
}

function scanForbiddenBuildReferences(root, privatePaths, homePath) {
  const tokens = privatePaths
    .filter((path) => typeof path === "string" && path.length > 1)
    .map((path) => Buffer.from(path));
  const homeToken = Buffer.from(homePath);
  for (const path of listRegularFiles(root)) {
    const relativePath = portable(relative(root, path));
    const content = readFileSync(path);
    if (tokens.some((token) => content.includes(token))) {
      throw new Error(`Package file contains a private build path: ${relativePath}.`);
    }
    const activeRuntimeMetadata =
      basename(path) === "package.json" ||
      [".js", ".cjs", ".mjs"].includes(extname(path)) ||
      relativePath.startsWith("dist/") ||
      (relativePath.includes("/node_modules/@hostdeck/") &&
        (relativePath.includes("/dist/") || relativePath.endsWith("/package.json")));
    if (activeRuntimeMetadata && content.includes(homeToken)) {
      throw new Error(`Package runtime metadata contains a private home path: ${relativePath}.`);
    }
    if (basename(path) === "package.json") {
      const manifest = JSON.parse(content.toString("utf8"));
      for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const specifier of Object.values(manifest[section] ?? {})) {
          if (
            typeof specifier === "string" &&
            (specifier.startsWith("workspace:") || specifier.startsWith("link:") || specifier.startsWith("file:"))
          ) {
            throw new Error(`Package manifest contains a source dependency reference: ${relativePath}.`);
          }
        }
      }
    }
  }
  for (const link of listSymbolicLinks(root)) {
    const target = readlinkSync(link);
    const encodedTarget = Buffer.from(target);
    if (tokens.some((token) => encodedTarget.includes(token)) || encodedTarget.includes(homeToken)) {
      throw new Error(`Package symlink contains a private build path: ${portable(relative(root, link))}.`);
    }
  }
}

export function publishCompletedPackage(stagedPackage, outputRoot) {
  const parent = dirname(outputRoot);
  const previous = join(parent, `.hostdeck-previous-${process.pid}`);
  removeTree(previous);
  let movedPrevious = false;
  try {
    if (existsSync(outputRoot)) {
      renameSync(outputRoot, previous);
      movedPrevious = true;
    }
    renameSync(stagedPackage, outputRoot);
  } catch (cause) {
    if (movedPrevious && !existsSync(outputRoot) && existsSync(previous)) renameSync(previous, outputRoot);
    throw new Error("Unable to publish the completed HostDeck package.", { cause });
  }
  if (movedPrevious) removeTree(previous);
}

function readCodexBindingIdentity(repositoryRoot) {
  const source = readFileSync(
    join(repositoryRoot, "packages", "codex-adapter", "src", "binding-manifest.generated.ts"),
    "utf8"
  );
  const match = source.match(/export const generatedCodexBindingManifest = (\{[\s\S]*?\}) as const;/u);
  if (match?.[1] === undefined) throw new Error("Generated Codex binding manifest is not parseable.");
  const value = JSON.parse(match[1]);
  if (
    value.schemaVersion !== 1 ||
    value.experimentalApi !== true ||
    typeof value.codexVersion !== "string" ||
    typeof value.bindingId !== "string" ||
    typeof value.fileCount !== "number" ||
    typeof value.treeSha256 !== "string"
  ) {
    throw new Error("Generated Codex binding manifest identity is invalid.");
  }
  return Object.freeze({
    bindingId: value.bindingId,
    codexVersion: value.codexVersion,
    experimentalApi: true,
    fileCount: value.fileCount,
    treeSha256: value.treeSha256
  });
}

function countSourcesByPackage(sources) {
  const counts = new Map(packageNames.map((name) => [name, 0]));
  for (const source of sources) {
    const name = source.split("/")[1];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count < 1) throw new Error(`Selected source closure does not contain @hostdeck/${name}.`);
  }
  return counts;
}

function runPnpm(repositoryRoot, args, label = "pnpm") {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && existsSync(npmExecPath)) {
    return runChecked(process.execPath, [npmExecPath, ...args], repositoryRoot, label);
  }
  return runChecked("pnpm", args, repositoryRoot, label);
}

function runChecked(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_offline: "true"
    },
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error !== undefined || result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4_000);
    throw new Error(`${label} failed${output.length === 0 ? "." : `:\n${output}`}`, { cause: result.error });
  }
  return Object.freeze({ stderr: result.stderr ?? "", stdout: result.stdout ?? "" });
}

function listRegularFiles(root) {
  return walk(root, (stats) => stats.isFile());
}

function listSymbolicLinks(root) {
  return walk(root, (stats) => stats.isSymbolicLink());
}

function listDirectories(root) {
  return walk(root, (stats) => stats.isDirectory());
}

function walk(root, select) {
  const paths = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) visit(path);
      if (select(stats)) paths.push(path);
    }
  }
  visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseExactVersion(value, label) {
  if (typeof value !== "string" || !exactVersionPattern.test(value)) {
    throw new TypeError(`${label} must be an exact semantic version.`);
  }
  return value;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function portable(path) {
  return path.split(sep).join("/");
}

function isInside(root, target) {
  const candidate = relative(root, target);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function removeTree(path) {
  if (!existsSync(path) && lstatOrNull(path) === null) return;
  makeTreeRemovable(path);
  rmSync(path, { force: true, recursive: true });
}

function makeTreeRemovable(path) {
  const stats = lstatOrNull(path);
  if (stats === null || stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeTreeRemovable(join(path, entry));
  } else if (stats.isFile()) {
    chmodSync(path, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = buildProductionPackage();
    console.log(
      `HostDeck package built: ${result.sourceCount} sources, ${result.outputCount} owned outputs, ${result.entryCount} entries, sha256:${result.contentSha256}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HostDeck package build failed: ${message}`);
    process.exitCode = 1;
  }
}
