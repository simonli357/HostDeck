import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const productionPackageManifestName = "hostdeck-package.json";
export const productionPackageVerifierName = "verify.mjs";

const expectedPackageNames = [
  "@hostdeck/core",
  "@hostdeck/contracts",
  "@hostdeck/codex-adapter",
  "@hostdeck/storage",
  "@hostdeck/server",
  "@hostdeck/cli"
];
const expectedDeferrals = [
  "IFC-V1-053",
  "IFC-V1-054",
  "IFC-V1-055",
  "IFC-V1-056",
  "IFC-V1-057",
  "IFC-V1-058"
];
const supportedBuildRuntime = Object.freeze({
  architecture: "x64",
  node: "22.22.2",
  nodeAbi: "127",
  platform: "linux",
  pnpm: "10.29.2"
});
const sha256Pattern = /^[a-f0-9]{64}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function currentRuntimeIdentity() {
  return Object.freeze({
    architecture: process.arch,
    node: process.versions.node,
    nodeAbi: process.versions.modules,
    platform: process.platform
  });
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Package identity cannot contain undefined values.");
  return serialized;
}

export function computeManifestSha256(manifest) {
  const value = assertRecord(manifest, "Package manifest");
  const unsigned = { ...value };
  delete unsigned.manifestSha256;
  return sha256Hex(stableJson(unsigned));
}

export function computeFileIdentity(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of sorted) {
    const path = parseRelativePath(entry.path, "Identity path", false);
    if (seen.has(path)) throw new TypeError(`Identity path is duplicated: ${path}`);
    seen.add(path);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    updateFramed(hash, "file");
    updateFramed(hash, path);
    updateFramed(hash, String(content.length));
    hash.update(content);
    bytes += content.length;
  }
  return Object.freeze({ bytes, count: sorted.length, sha256: hash.digest("hex") });
}

export function inspectProductionPackageTree(root, executableFiles = []) {
  const packageRoot = realpathSync(resolve(root));
  assertDirectoryMode(lstatSync(packageRoot).mode, ".");
  const executableSet = new Set(executableFiles.map((path) => parseRelativePath(path, "Executable path", false)));
  if (executableSet.size !== executableFiles.length) {
    throw new TypeError("Executable path inventory contains duplicates.");
  }
  const hash = createHash("sha256");
  const seenExecutables = new Set();
  let bytes = 0;
  let entryCount = 0;

  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = toPortablePath(
        relativeDirectory.length === 0 ? entry.name : join(relativeDirectory, entry.name)
      );
      if (relativePath === productionPackageManifestName) continue;
      const stats = lstatSync(path);
      entryCount += 1;

      if (stats.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) throw new TypeError(`Package symlink is absolute: ${relativePath}`);
        let resolvedTarget;
        try {
          resolvedTarget = realpathSync(resolve(dirname(path), target));
        } catch {
          throw new TypeError(`Package symlink is broken: ${relativePath}`);
        }
        if (!isInside(packageRoot, resolvedTarget)) {
          throw new TypeError(`Package symlink escapes the package: ${relativePath}`);
        }
        updateFramed(hash, "link");
        updateFramed(hash, relativePath);
        updateFramed(hash, target);
        continue;
      }

      if (stats.isDirectory()) {
        assertDirectoryMode(stats.mode, relativePath);
        updateFramed(hash, "directory");
        updateFramed(hash, relativePath);
        visit(path, relativePath);
        continue;
      }

      if (!stats.isFile()) throw new TypeError(`Package contains a special filesystem entry: ${relativePath}`);
      if (stats.nlink !== 1) throw new TypeError(`Package regular file is hard-linked: ${relativePath}`);
      const executable = executableSet.has(relativePath);
      assertFileMode(stats.mode, relativePath, executable);
      if (executable) seenExecutables.add(relativePath);
      const content = readFileSync(path);
      bytes += content.length;
      updateFramed(hash, "file");
      updateFramed(hash, relativePath);
      updateFramed(hash, String(content.length));
      hash.update(content);
    }
  }

  visit(packageRoot, "");
  for (const path of executableSet) {
    if (!seenExecutables.has(path)) throw new TypeError(`Declared executable file is missing: ${path}`);
  }
  return Object.freeze({ bytes, entryCount, sha256: hash.digest("hex") });
}

export function computeOwnedOutputIdentity(root, packageDescriptors) {
  const packageRoot = realpathSync(resolve(root));
  const entries = [];
  let compiledCount = 0;

  for (const descriptor of packageDescriptors) {
    const packagePath = resolveContained(packageRoot, descriptor.root, `${descriptor.name} package root`);
    const resolvedPackagePath = realpathSync(packagePath);
    if (!isInside(packageRoot, resolvedPackagePath)) {
      throw new TypeError(`${descriptor.name} package root escapes the package.`);
    }
    const allowedRootEntries = new Set(["dist", "node_modules", "package.json"]);
    if (descriptor.name === "@hostdeck/cli") {
      allowedRootEntries.add(productionPackageManifestName);
      allowedRootEntries.add(productionPackageVerifierName);
    }
    for (const entry of readdirSync(resolvedPackagePath, { withFileTypes: true })) {
      if (!allowedRootEntries.has(entry.name)) {
        throw new TypeError(`${descriptor.name} contains undeclared owned root entry ${entry.name}.`);
      }
    }

    const manifestPath = join(resolvedPackagePath, "package.json");
    entries.push({
      content: readRequiredFile(manifestPath, `${descriptor.name} package.json`),
      path: `${descriptor.name}/package.json`
    });
    const distPath = join(resolvedPackagePath, "dist");
    const packageCompiled = collectCompiledOutput(distPath, descriptor.name);
    if (packageCompiled.length !== descriptor.outputCount) {
      throw new TypeError(
        `${descriptor.name} compiled output count is ${packageCompiled.length}; expected ${descriptor.outputCount}.`
      );
    }
    compiledCount += packageCompiled.length;
    entries.push(...packageCompiled);
  }

  entries.push({
    content: readRequiredFile(join(packageRoot, productionPackageVerifierName), "Package verifier"),
    path: productionPackageVerifierName
  });
  const identity = computeFileIdentity(entries);
  return Object.freeze({ ...identity, compiledCount });
}

export function verifyProductionPackage(root, options = {}) {
  const packageRoot = realpathSync(resolve(root));
  const manifestPath = join(packageRoot, productionPackageManifestName);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new TypeError("HostDeck package manifest is missing or invalid JSON.", { cause });
  }
  const manifestStats = lstatSync(manifestPath);
  if (!manifestStats.isFile() || manifestStats.nlink !== 1) {
    throw new TypeError("HostDeck package manifest must be one regular non-linked file.");
  }
  assertFileMode(manifestStats.mode, productionPackageManifestName, false);
  validateManifest(manifest);
  const expectedManifestHash = computeManifestSha256(manifest);
  if (manifest.manifestSha256 !== expectedManifestHash) {
    throw new TypeError("HostDeck package manifest identity does not match its contents.");
  }

  const runtime = options.runtime ?? currentRuntimeIdentity();
  assertRuntimeIdentity(manifest.runtime, runtime);
  verifyPackageManifests(packageRoot, manifest);
  verifyNoOwnedExecutables(packageRoot, manifest.packages, manifest.executableFiles);

  const tree = inspectProductionPackageTree(packageRoot, manifest.executableFiles);
  const owned = computeOwnedOutputIdentity(packageRoot, manifest.packages);
  assertIdentity(manifest.output, owned, "Owned output");
  assertIdentity(manifest.content, tree, "Package content", "entryCount");
  verifyNativeModules(packageRoot, manifest.nativeModules, manifest.executableFiles);

  return Object.freeze({
    contentSha256: tree.sha256,
    entryCount: tree.entryCount,
    outputCount: owned.count,
    packageVersion: manifest.packageVersion,
    sourceCount: manifest.source.count
  });
}

function validateManifest(manifest) {
  const value = assertRecord(manifest, "Package manifest");
  assertExactKeys(
    value,
    [
      "codex",
      "content",
      "deferrals",
      "executableFiles",
      "manifestSha256",
      "name",
      "nativeBuildPolicy",
      "nativeModules",
      "output",
      "packageManager",
      "packageVersion",
      "packages",
      "runtime",
      "schemaVersion",
      "source"
    ],
    "Package manifest"
  );
  if (value.schemaVersion !== 1 || value.name !== "hostdeck-production-package") {
    throw new TypeError("HostDeck package manifest schema is unsupported.");
  }
  if (value.nativeBuildPolicy !== "canonical-runtime-binary-only") {
    throw new TypeError("Native build-output policy is unsupported.");
  }
  parseExactVersion(value.packageVersion, "Package version");
  parseSha256(value.manifestSha256, "Manifest SHA-256");

  const runtime = assertRecord(value.runtime, "Runtime identity");
  assertExactKeys(runtime, ["architecture", "node", "nodeAbi", "platform", "pnpm"], "Runtime identity");
  for (const [key, expected] of Object.entries(supportedBuildRuntime)) {
    if (runtime[key] !== expected) throw new TypeError(`Package runtime ${key} is unsupported.`);
  }
  if (value.packageManager !== `pnpm@${runtime.pnpm}`) {
    throw new TypeError("Package-manager identity is inconsistent.");
  }

  validateIdentity(value.source, "Source identity", "count");
  if (value.source.count !== 605) throw new TypeError("Selected source count must be exactly 605.");
  validateIdentity(value.output, "Owned output identity", "count");
  validateIdentity(value.content, "Package content identity", "entryCount");
  if (!Number.isSafeInteger(value.content.bytes) || value.content.bytes < 1) {
    throw new TypeError("Package content byte count is invalid.");
  }

  const codex = assertRecord(value.codex, "Codex identity");
  assertExactKeys(
    codex,
    ["bindingId", "codexVersion", "experimentalApi", "fileCount", "treeSha256"],
    "Codex identity"
  );
  parseExactVersion(codex.codexVersion, "Codex version");
  parseSha256(codex.treeSha256, "Codex tree SHA-256");
  if (
    codex.experimentalApi !== true ||
    !Number.isSafeInteger(codex.fileCount) ||
    codex.fileCount < 1 ||
    codex.bindingId !== `codex-app-server-${codex.codexVersion}-experimental:sha256:${codex.treeSha256}`
  ) {
    throw new TypeError("Codex package identity is inconsistent.");
  }

  if (!Array.isArray(value.deferrals) || !sameArray(value.deferrals, expectedDeferrals)) {
    throw new TypeError("Package downstream deferrals are invalid.");
  }
  validatePackages(value.packages, value.packageVersion, value.output);
  validateExecutables(value.executableFiles);
  validateNativeManifest(value.nativeModules, value.executableFiles);
}

function validateIdentity(identity, label, countKey) {
  const value = assertRecord(identity, label);
  const keys = countKey === "entryCount" ? ["bytes", "entryCount", "sha256"] : [countKey, "sha256"];
  assertExactKeys(value, keys, label);
  if (!Number.isSafeInteger(value[countKey]) || value[countKey] < 1) {
    throw new TypeError(`${label} count is invalid.`);
  }
  parseSha256(value.sha256, `${label} SHA-256`);
}

function validatePackages(packages, packageVersion, outputIdentity) {
  if (!Array.isArray(packages) || packages.length !== expectedPackageNames.length) {
    throw new TypeError("Runtime package inventory is invalid.");
  }
  let sourceCount = 0;
  let compiledCount = 0;
  for (const [index, expectedName] of expectedPackageNames.entries()) {
    const descriptor = assertRecord(packages[index], "Runtime package descriptor");
    assertExactKeys(
      descriptor,
      ["dependencies", "entrypoint", "name", "outputCount", "root", "sourceCount", "types", "version"],
      "Runtime package descriptor"
    );
    if (descriptor.name !== expectedName || descriptor.version !== packageVersion) {
      throw new TypeError("Runtime package name or version is inconsistent.");
    }
    parseRelativePath(descriptor.root, `${expectedName} root`, true);
    parseRelativePath(descriptor.entrypoint, `${expectedName} entrypoint`, false);
    parseRelativePath(descriptor.types, `${expectedName} types`, false);
    if (!Number.isSafeInteger(descriptor.sourceCount) || descriptor.sourceCount < 1) {
      throw new TypeError(`${expectedName} source count is invalid.`);
    }
    if (descriptor.outputCount !== descriptor.sourceCount * 2) {
      throw new TypeError(`${expectedName} output count is inconsistent.`);
    }
    validateDependencies(descriptor.dependencies, expectedName);
    sourceCount += descriptor.sourceCount;
    compiledCount += descriptor.outputCount;
  }
  if (sourceCount !== 605 || outputIdentity.count !== compiledCount + packages.length + 1) {
    throw new TypeError("Owned source/output aggregate is inconsistent.");
  }
}

function validateDependencies(dependencies, packageName) {
  const value = assertRecord(dependencies, `${packageName} dependencies`);
  const names = Object.keys(value);
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  if (!sameArray(names, sorted)) throw new TypeError(`${packageName} dependencies are not sorted.`);
  for (const [name, version] of Object.entries(value)) {
    if (typeof name !== "string" || !exactVersionPattern.test(version)) {
      throw new TypeError(`${packageName} dependency ${name} is not pinned exactly.`);
    }
  }
}

function validateExecutables(executables) {
  if (!Array.isArray(executables)) throw new TypeError("Executable inventory must be an array.");
  const parsed = executables.map((path) => parseRelativePath(path, "Executable path", false));
  const sorted = [...parsed].sort((left, right) => left.localeCompare(right));
  if (!sameArray(parsed, sorted) || new Set(parsed).size !== parsed.length) {
    throw new TypeError("Executable inventory must be sorted and unique.");
  }
  if (parsed.some((path) => path.startsWith("dist/") || path === productionPackageVerifierName)) {
    throw new TypeError("HostDeck-owned files cannot be executable in this package foundation.");
  }
}

function validateNativeManifest(nativeModules, executableFiles) {
  if (!Array.isArray(nativeModules) || nativeModules.length !== 2) {
    throw new TypeError("Required native-module inventory must contain exactly two entries.");
  }
  const expected = ["better-sqlite3", "fs-ext"];
  const executableSet = new Set(executableFiles);
  for (const [index, packageName] of expected.entries()) {
    const native = assertRecord(nativeModules[index], "Native-module descriptor");
    assertExactKeys(native, ["package", "path", "sha256", "size"], "Native-module descriptor");
    if (native.package !== packageName) throw new TypeError("Required native-module order or identity is invalid.");
    const path = parseRelativePath(native.path, `${packageName} native path`, false);
    if (!path.endsWith(".node") || !executableSet.has(path)) {
      throw new TypeError(`${packageName} native path is not a declared executable module.`);
    }
    parseSha256(native.sha256, `${packageName} native SHA-256`);
    if (!Number.isSafeInteger(native.size) || native.size < 1) {
      throw new TypeError(`${packageName} native size is invalid.`);
    }
  }
}

function assertRuntimeIdentity(expected, actual) {
  const runtime = assertRecord(actual, "Current runtime identity");
  for (const key of ["node", "platform", "architecture", "nodeAbi"]) {
    if (runtime[key] !== expected[key]) {
      throw new TypeError(`Current runtime ${key} does not match the package contract.`);
    }
  }
}

function verifyPackageManifests(root, manifest) {
  const resolvedRoots = new Set();
  for (const descriptor of manifest.packages) {
    const packagePath = resolveContained(root, descriptor.root, `${descriptor.name} root`);
    const resolvedRoot = requireRealPath(packagePath, `${descriptor.name} package root`);
    if (!isInside(root, resolvedRoot) || resolvedRoots.has(resolvedRoot)) {
      throw new TypeError(`${descriptor.name} package root is escaping or duplicated.`);
    }
    resolvedRoots.add(resolvedRoot);
    const runtimeManifest = readRequiredJson(join(resolvedRoot, "package.json"), `${descriptor.name} package.json`);
    const expectedKeys = ["engines", "exports", "name", "private", "type", "types", "version"];
    if (Object.keys(descriptor.dependencies).length > 0) expectedKeys.push("dependencies");
    assertExactKeys(runtimeManifest, expectedKeys, `${descriptor.name} package.json`);
    if (
      runtimeManifest.name !== descriptor.name ||
      runtimeManifest.version !== manifest.packageVersion ||
      runtimeManifest.private !== true ||
      runtimeManifest.type !== "module" ||
      runtimeManifest.types !== "./dist/index.d.ts" ||
      runtimeManifest.engines?.node !== manifest.runtime.node ||
      stableJson(runtimeManifest.dependencies ?? {}) !== stableJson(descriptor.dependencies) ||
      stableJson(runtimeManifest.exports) !==
        stableJson({ ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } })
    ) {
      throw new TypeError(`${descriptor.name} runtime manifest is inconsistent.`);
    }
    const entrypoint = resolveContained(root, descriptor.entrypoint, `${descriptor.name} entrypoint`);
    const types = resolveContained(root, descriptor.types, `${descriptor.name} types`);
    if (!isRequiredRegularFile(entrypoint) || !isRequiredRegularFile(types)) {
      throw new TypeError(`${descriptor.name} emitted entrypoints are missing.`);
    }
  }
}

function verifyNativeModules(root, nativeModules, executableFiles) {
  const executableSet = new Set(executableFiles);
  for (const native of nativeModules) {
    const path = resolveContained(root, native.path, `${native.package} native path`);
    const stats = lstatOrNull(path);
    if (stats === null || !stats.isFile() || stats.size !== native.size || !executableSet.has(native.path)) {
      throw new TypeError(`${native.package} native module is missing or incompatible.`);
    }
    if (sha256Hex(readFileSync(path)) !== native.sha256) {
      throw new TypeError(`${native.package} native module integrity check failed.`);
    }
  }
}

function verifyNoOwnedExecutables(root, packages, executableFiles) {
  const ownedDistRoots = packages.map((descriptor) =>
    requireRealPath(
      resolveContained(root, `${descriptor.root === "." ? "" : `${descriptor.root}/`}dist`, `${descriptor.name} dist`),
      `${descriptor.name} compiled output`
    )
  );
  for (const executable of executableFiles) {
    const path = requireRealPath(
      resolveContained(root, executable, "Executable path"),
      `Declared executable ${executable}`
    );
    if (ownedDistRoots.some((distRoot) => isInside(distRoot, path))) {
      throw new TypeError("HostDeck-owned compiled output cannot be executable in this package foundation.");
    }
  }
}

function collectCompiledOutput(distRoot, packageName) {
  const entries = [];
  const extensions = new Map();

  function visit(directory, relativeDirectory) {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = toPortablePath(
        relativeDirectory.length === 0 ? child.name : join(relativeDirectory, child.name)
      );
      if (child.isSymbolicLink()) throw new TypeError(`${packageName} compiled output contains a symlink.`);
      if (child.isDirectory()) {
        visit(path, relativePath);
        continue;
      }
      if (!child.isFile() || (!relativePath.endsWith(".js") && !relativePath.endsWith(".d.ts"))) {
        throw new TypeError(`${packageName} compiled output contains forbidden file ${relativePath}.`);
      }
      const base = relativePath.endsWith(".d.ts") ? relativePath.slice(0, -5) : relativePath.slice(0, -3);
      const kind = relativePath.endsWith(".d.ts") ? "types" : "javascript";
      const pair = extensions.get(base) ?? new Set();
      pair.add(kind);
      extensions.set(base, pair);
      const content = readFileSync(path);
      if (content.includes(Buffer.from("sourceMappingURL=")) || content.includes(Buffer.from("sourcesContent"))) {
        throw new TypeError(`${packageName} compiled output contains source-map data.`);
      }
      entries.push({ content, path: `${packageName}/dist/${relativePath}` });
    }
  }

  visit(distRoot, "");
  for (const [base, pair] of extensions) {
    if (pair.size !== 2) throw new TypeError(`${packageName} compiled output pair is incomplete: ${base}`);
  }
  return entries;
}

function assertIdentity(expected, actual, label, countKey = "count") {
  if (
    expected[countKey] !== actual[countKey] ||
    expected.sha256 !== actual.sha256 ||
    (expected.bytes !== undefined && expected.bytes !== actual.bytes)
  ) {
    throw new TypeError(`${label} identity does not match the package tree.`);
  }
}

function readRequiredJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError(`${label} is missing or invalid JSON.`);
  }
}

function readRequiredFile(path, label) {
  try {
    return readFileSync(path);
  } catch {
    throw new TypeError(`${label} is missing or unreadable.`);
  }
}

function requireRealPath(path, label) {
  try {
    return realpathSync(path);
  } catch {
    throw new TypeError(`${label} is missing or unreadable.`);
  }
}

function isRequiredRegularFile(path) {
  return lstatOrNull(path)?.isFile() === true;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function assertDirectoryMode(mode, path) {
  const permissions = mode & 0o777;
  if (permissions !== 0o755 && permissions !== 0o555) {
    throw new TypeError(`Package directory mode is invalid: ${path}`);
  }
}

function assertFileMode(mode, path, executable) {
  const permissions = mode & 0o777;
  const accepted = executable ? permissions === 0o755 || permissions === 0o555 : permissions === 0o644 || permissions === 0o444;
  if (!accepted) throw new TypeError(`Package file mode is invalid: ${path}`);
}

function parseRelativePath(value, label, allowDot) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    (!allowDot && value === ".")
  ) {
    throw new TypeError(`${label} must be a portable relative path.`);
  }
  const normalized = toPortablePath(resolve("/", value).slice(1));
  if (value !== normalized && !(allowDot && value === ".")) {
    throw new TypeError(`${label} must be normalized.`);
  }
  if (value === ".." || value.startsWith("../")) throw new TypeError(`${label} escapes its root.`);
  return value;
}

function resolveContained(root, path, label) {
  const parsed = parseRelativePath(path, label, true);
  const target = parsed === "." ? root : resolve(root, parsed);
  if (!isInside(root, target)) throw new TypeError(`${label} escapes the package.`);
  return target;
}

function parseSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function parseExactVersion(value, label) {
  if (typeof value !== "string" || !exactVersionPattern.test(value)) {
    throw new TypeError(`${label} must be an exact version.`);
  }
  return value;
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const sortedExpected = [...expected].sort();
  if (!sameArray(actual, sortedExpected)) throw new TypeError(`${label} fields are invalid.`);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isInside(root, target) {
  const candidate = relative(root, target);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function toPortablePath(path) {
  return path.split(sep).join("/");
}

function updateFramed(hash, value) {
  const content = Buffer.from(value);
  hash.update(String(content.length));
  hash.update(":");
  hash.update(content);
  hash.update(";");
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const root = process.argv[2] ?? dirname(resolve(process.argv[1]));
    const result = verifyProductionPackage(root);
    console.log(
      `HostDeck package verified: ${result.entryCount} entries, ${result.outputCount} owned outputs, sha256:${result.contentSha256}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HostDeck package verification failed: ${message.slice(0, 500)}`);
    process.exitCode = 1;
  }
}
