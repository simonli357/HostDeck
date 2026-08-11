import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const productionPackageManifestName = "hostdeck-package.json";
export const productionPackageSourceCount = 623;
export const productionPackageVerifierName = "verify.mjs";
export const productionWebManifestName = "hostdeck-web.json";
export const productionWebManifestSchemaVersion = 1;
export const productionWebViteVersion = "8.1.4";
export const productionWebBrowserRoutes = Object.freeze([
  "/",
  "/sessions/:session_id"
]);
export const productionWebLimits = Object.freeze({
  indexMaxBytes: 2_097_152,
  maxAssetDepth: 16,
  maxAssetEntries: 20_000,
  maxAssetFileBytes: 33_554_432,
  maxAssetFiles: 10_000,
  maxAssetTotalBytes: 268_435_456,
  manifestMaxBytes: 1_048_576
});

const expectedPackageNames = [
  "@hostdeck/core",
  "@hostdeck/contracts",
  "@hostdeck/codex-adapter",
  "@hostdeck/storage",
  "@hostdeck/server",
  "@hostdeck/cli"
];
const expectedDeferrals = [];
const supportedBuildRuntime = Object.freeze({
  architecture: "x64",
  node: "22.22.2",
  nodeAbi: "127",
  platform: "linux",
  pnpm: "10.29.2"
});
const sha256Pattern = /^[a-f0-9]{64}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const hashedWebAssetPattern = /-[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9]+)+$/u;
const safeWebAssetSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u;
const productionWebCacheControl = "public, max-age=31536000, immutable";
const productionWebMediaTypes = Object.freeze({
  ".css": "text/css",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
});

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

export function productionWebMediaType(path) {
  const parsed = parseRelativePath(path, "Web asset path", false);
  assertSafeWebAssetPath(parsed);
  const mediaType = productionWebMediaTypes[extname(parsed).toLowerCase()];
  if (mediaType === undefined) {
    throw new TypeError(`Web asset media type is unsupported: ${parsed}`);
  }
  return mediaType;
}

export function createProductionWebManifest(input) {
  const value = assertRecord(input, "Production web-manifest input");
  assertExactKeys(
    value,
    ["assets", "browserRoutes", "entryAssets", "index", "packageVersion", "viteVersion"],
    "Production web-manifest input"
  );
  parseExactVersion(value.packageVersion, "Web package version");
  if (value.viteVersion !== productionWebViteVersion) {
    throw new TypeError("Web Vite version is unsupported.");
  }
  const browserRoutes = validateWebBrowserRoutes(value.browserRoutes, productionWebBrowserRoutes);
  const index = createWebFileDescriptor(value.index, "index.html", "text/html", "no-store");
  if (
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > productionWebLimits.maxAssetFiles
  ) {
    throw new TypeError("Web asset descriptors are invalid.");
  }
  const assets = value.assets.map((asset) => createWebAssetDescriptor(asset));
  const paths = assets.map((asset) => asset.path);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  if (
    !sameArray(paths, sortedPaths) ||
    new Set(paths).size !== paths.length ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
  ) {
    throw new TypeError("Web asset descriptors must be sorted and case-unique.");
  }
  const entryAssets = validateWebEntryAssets(value.entryAssets, new Set(paths));
  const content = computeFileIdentity([
    { content: value.index.content, path: index.path },
    ...assets.map((asset, position) => ({ content: value.assets[position].content, path: asset.path }))
  ]);
  const manifest = {
    schemaVersion: productionWebManifestSchemaVersion,
    name: "hostdeck-production-web",
    packageVersion: value.packageVersion,
    viteVersion: value.viteVersion,
    browserRoutes,
    entryAssets,
    index: stripWebFileContent(index),
    assets: assets.map(stripWebFileContent),
    content
  };
  validateProductionWebManifest(manifest, {
    browserRoutes,
    packageVersion: value.packageVersion,
    viteVersion: value.viteVersion
  });
  return Object.freeze(manifest);
}

export function verifyProductionWebAssets(root, options = {}) {
  const requestedWebRoot = resolve(root);
  const rootStats = lstatOrNull(requestedWebRoot);
  if (
    rootStats === null ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    requireRealPath(requestedWebRoot, "Production web root") !== requestedWebRoot
  ) {
    throw new TypeError("Production web root must be one real directory.");
  }
  const webRoot = requestedWebRoot;
  assertDirectoryMode(rootStats.mode, "web");

  const manifestPath = join(webRoot, productionWebManifestName);
  let manifestStats;
  try {
    manifestStats = lstatSync(manifestPath);
  } catch (cause) {
    throw new TypeError("Production web manifest is missing or unreadable.", { cause });
  }
  if (
    !manifestStats.isFile() ||
    manifestStats.isSymbolicLink() ||
    manifestStats.nlink !== 1 ||
    manifestStats.size < 1 ||
    manifestStats.size > productionWebLimits.manifestMaxBytes ||
    realpathSync(manifestPath) !== manifestPath
  ) {
    throw new TypeError("Production web manifest must be one bounded canonical non-linked file.");
  }
  assertFileMode(manifestStats.mode, productionWebManifestName, false);
  const manifestBytes = readRequiredFile(manifestPath, "Production web manifest");
  let manifest;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
    );
  } catch (cause) {
    throw new TypeError("Production web manifest is invalid JSON or UTF-8.", { cause });
  }
  validateProductionWebManifest(manifest, options);

  const rootEntries = readdirSync(webRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (!sameArray(rootEntries, ["assets", productionWebManifestName, "index.html"].sort())) {
    throw new TypeError("Production web root inventory is invalid.");
  }
  const assetsRoot = requireRealPath(join(webRoot, "assets"), "Production web assets root");
  const assetsRootStats = lstatSync(assetsRoot);
  if (!assetsRootStats.isDirectory() || assetsRootStats.isSymbolicLink()) {
    throw new TypeError("Production web assets root must be one real directory.");
  }
  assertDirectoryMode(assetsRootStats.mode, "web/assets");

  const expectedFiles = [manifest.index, ...manifest.assets];
  const expectedAssetDirectories = new Set(["assets"]);
  for (const descriptor of manifest.assets) {
    const segments = descriptor.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedAssetDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const actualPaths = listWebRegularFiles(
    webRoot,
    expectedAssetDirectories
  ).filter(
    (path) => path !== productionWebManifestName
  );
  const expectedPaths = expectedFiles
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  if (!sameArray(actualPaths, expectedPaths)) {
    throw new TypeError("Production web file inventory does not match its manifest.");
  }
  const identityEntries = [];
  for (const descriptor of expectedFiles) {
    const path = resolveContained(webRoot, descriptor.path, "Production web file path");
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      realpathSync(path) !== path
    ) {
      throw new TypeError(`Production web file is not canonical: ${descriptor.path}`);
    }
    assertFileMode(stats.mode, `web/${descriptor.path}`, false);
    const content = readFileSync(path);
    if (
      content.length !== descriptor.size ||
      sha256Hex(content) !== descriptor.sha256
    ) {
      throw new TypeError(`Production web file identity is invalid: ${descriptor.path}`);
    }
    identityEntries.push({ content, path: descriptor.path });
  }
  const content = computeFileIdentity(identityEntries);
  assertIdentity(manifest.content, content, "Production web content");
  validateProductionWebIndex(
    identityEntries.find((entry) => entry.path === "index.html").content,
    manifest
  );

  const result = Object.freeze({
    assetCount: manifest.assets.length,
    browserRoutes: manifest.browserRoutes,
    bytes: content.bytes,
    fileCount: content.count,
    indexPath: "web/index.html",
    manifestPath: `web/${productionWebManifestName}`,
    manifestSha256: sha256Hex(manifestBytes),
    manifestSize: manifestBytes.length,
    packageVersion: manifest.packageVersion,
    root: "web",
    schemaVersion: manifest.schemaVersion,
    sha256: content.sha256,
    viteVersion: manifest.viteVersion
  });
  if (options.descriptor !== undefined) {
    assertWebDescriptorIdentity(options.descriptor, result);
  }
  return result;
}

function createWebFileDescriptor(candidate, expectedPath, expectedMediaType, expectedCacheControl) {
  const value = assertRecord(candidate, "Web file descriptor input");
  assertExactKeys(value, ["content", "path"], "Web file descriptor input");
  const path = parseRelativePath(value.path, "Web file path", false);
  if (path !== expectedPath) throw new TypeError(`Web file path must be ${expectedPath}.`);
  const content = Buffer.isBuffer(value.content) ? value.content : Buffer.from(value.content);
  const maximumBytes = expectedPath === "index.html"
    ? productionWebLimits.indexMaxBytes
    : productionWebLimits.maxAssetFileBytes;
  if (content.length < 1 || content.length > maximumBytes) {
    throw new TypeError(`Web file size is invalid: ${path}`);
  }
  return Object.freeze({
    cacheControl: expectedCacheControl,
    content,
    mediaType: expectedMediaType,
    path,
    sha256: sha256Hex(content),
    size: content.length
  });
}

function createWebAssetDescriptor(candidate) {
  const value = assertRecord(candidate, "Web asset descriptor input");
  assertExactKeys(value, ["content", "path"], "Web asset descriptor input");
  const path = parseRelativePath(value.path, "Web asset path", false);
  if (
    !path.startsWith("assets/") ||
    path === "assets/" ||
    !hashedWebAssetPattern.test(basename(path))
  ) {
    throw new TypeError(`Web asset path is not content-hashed: ${path}`);
  }
  return createWebFileDescriptor(
    value,
    path,
    productionWebMediaType(path),
    productionWebCacheControl
  );
}

function stripWebFileContent(descriptor) {
  return Object.freeze({
    cacheControl: descriptor.cacheControl,
    mediaType: descriptor.mediaType,
    path: descriptor.path,
    sha256: descriptor.sha256,
    size: descriptor.size
  });
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
      assertProductionPackagePathPolicy(relativePath);
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

function assertProductionPackagePathPolicy(relativePath) {
  const name = basename(relativePath).toLowerCase();
  if (name.endsWith(".map")) {
    throw new TypeError(`Package contains a forbidden source map: ${relativePath}`);
  }
  if (name === ".env" || name.startsWith(".env.")) {
    throw new TypeError(`Package contains a forbidden environment file: ${relativePath}`);
  }
  if (
    name === ".netrc" ||
    name === ".npmrc" ||
    /\.(?:cer|crt|key|p12|pem|pfx)$/u.test(name)
  ) {
    throw new TypeError(`Package contains a forbidden credential file: ${relativePath}`);
  }
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
      allowedRootEntries.add("web");
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
  verifyCommand(packageRoot, manifest.command, manifest.executableFiles);
  verifyServiceHost(packageRoot, manifest.serviceHost, manifest.executableFiles);
  const web = verifyProductionWebAssets(
    resolveContained(packageRoot, manifest.web.root, "Production web root"),
    {
      browserRoutes: manifest.web.browserRoutes,
      descriptor: manifest.web,
      packageVersion: manifest.packageVersion,
      viteVersion: manifest.web.viteVersion
    }
  );
  verifyNoOwnedExecutables(packageRoot, manifest.packages, manifest.executableFiles, manifest.command.path);

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
    sourceCount: manifest.source.count,
    webBytes: web.bytes,
    webFileCount: web.fileCount,
    webSha256: web.sha256
  });
}

function validateManifest(manifest) {
  const value = assertRecord(manifest, "Package manifest");
  assertExactKeys(
    value,
    [
      "codex",
      "command",
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
      "serviceHost",
      "source",
      "web"
    ],
    "Package manifest"
  );
  if (value.schemaVersion !== 4 || value.name !== "hostdeck-production-package") {
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
  if (value.source.count !== productionPackageSourceCount) {
    throw new TypeError(
      `Selected source count must be exactly ${productionPackageSourceCount}.`
    );
  }
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

  validateCommand(value.command, value.packageVersion);
  validateServiceHost(value.serviceHost, value.packageVersion);
  validateWebDescriptor(value.web, value.packageVersion);

  if (!Array.isArray(value.deferrals) || !sameArray(value.deferrals, expectedDeferrals)) {
    throw new TypeError("Package downstream deferrals are invalid.");
  }
  validatePackages(value.packages, value.packageVersion, value.output);
  validateExecutables(value.executableFiles, value.command.path);
  validateNativeManifest(value.nativeModules, value.executableFiles);
}

function validateProductionWebManifest(manifest, options = {}) {
  const value = assertRecord(manifest, "Production web manifest");
  assertExactKeys(
    value,
    [
      "assets",
      "browserRoutes",
      "content",
      "entryAssets",
      "index",
      "name",
      "packageVersion",
      "schemaVersion",
      "viteVersion"
    ],
    "Production web manifest"
  );
  if (
    value.schemaVersion !== productionWebManifestSchemaVersion ||
    value.name !== "hostdeck-production-web"
  ) {
    throw new TypeError("Production web-manifest schema is unsupported.");
  }
  parseExactVersion(value.packageVersion, "Web package version");
  if (
    options.packageVersion !== undefined &&
    value.packageVersion !== options.packageVersion
  ) {
    throw new TypeError("Production web package version is inconsistent.");
  }
  if (value.viteVersion !== productionWebViteVersion) {
    throw new TypeError("Production web Vite version is unsupported.");
  }
  if (
    options.viteVersion !== undefined &&
    value.viteVersion !== options.viteVersion
  ) {
    throw new TypeError("Production web Vite version is inconsistent.");
  }
  const expectedRoutes = options.browserRoutes ?? productionWebBrowserRoutes;
  validateWebBrowserRoutes(value.browserRoutes, expectedRoutes);
  validateStoredWebFileDescriptor(
    value.index,
    "index.html",
    "text/html",
    "no-store",
    "Web index descriptor"
  );
  if (
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > productionWebLimits.maxAssetFiles
  ) {
    throw new TypeError("Production web asset inventory is invalid.");
  }
  const assetPaths = [];
  for (const asset of value.assets) {
    const descriptor = validateStoredWebFileDescriptor(
      asset,
      undefined,
      undefined,
      productionWebCacheControl,
      "Web asset descriptor"
    );
    if (
      !descriptor.path.startsWith("assets/") ||
      descriptor.path === "assets/" ||
      !hashedWebAssetPattern.test(basename(descriptor.path)) ||
      descriptor.mediaType !== productionWebMediaType(descriptor.path)
    ) {
      throw new TypeError(`Production web asset descriptor is invalid: ${descriptor.path}`);
    }
    assetPaths.push(descriptor.path);
  }
  const sortedPaths = [...assetPaths].sort((left, right) => left.localeCompare(right));
  if (
    !sameArray(assetPaths, sortedPaths) ||
    new Set(assetPaths).size !== assetPaths.length ||
    new Set(assetPaths.map((path) => path.toLowerCase())).size !== assetPaths.length
  ) {
    throw new TypeError("Production web asset inventory must be sorted and case-unique.");
  }
  validateWebEntryAssets(value.entryAssets, new Set(assetPaths));
  validateWebContentIdentity(value.content);
  if (value.content.count !== value.assets.length + 1) {
    throw new TypeError("Production web content count is inconsistent.");
  }
  const declaredBytes = [value.index, ...value.assets].reduce(
    (total, descriptor) => total + descriptor.size,
    0
  );
  const declaredAssetBytes = value.assets.reduce(
    (total, descriptor) => total + descriptor.size,
    0
  );
  if (value.content.bytes !== declaredBytes) {
    throw new TypeError("Production web content byte count is inconsistent.");
  }
  if (declaredAssetBytes > productionWebLimits.maxAssetTotalBytes) {
    throw new TypeError("Production web asset bytes exceed the configured limit.");
  }
  return value;
}

function validateStoredWebFileDescriptor(candidate, expectedPath, expectedMediaType, expectedCacheControl, label) {
  const descriptor = assertRecord(candidate, label);
  assertExactKeys(
    descriptor,
    ["cacheControl", "mediaType", "path", "sha256", "size"],
    label
  );
  const path = parseRelativePath(descriptor.path, `${label} path`, false);
  if (expectedPath !== undefined && path !== expectedPath) {
    throw new TypeError(`${label} path is inconsistent.`);
  }
  if (
    typeof descriptor.mediaType !== "string" ||
    descriptor.mediaType.length < 1 ||
    (expectedMediaType !== undefined && descriptor.mediaType !== expectedMediaType) ||
    descriptor.cacheControl !== expectedCacheControl ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size >
      (expectedPath === "index.html"
        ? productionWebLimits.indexMaxBytes
        : productionWebLimits.maxAssetFileBytes)
  ) {
    throw new TypeError(`${label} response or size metadata is invalid.`);
  }
  parseSha256(descriptor.sha256, `${label} SHA-256`);
  return descriptor;
}

function validateWebContentIdentity(candidate) {
  const identity = assertRecord(candidate, "Production web content identity");
  assertExactKeys(identity, ["bytes", "count", "sha256"], "Production web content identity");
  if (
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1 ||
    !Number.isSafeInteger(identity.count) ||
    identity.count < 2
  ) {
    throw new TypeError("Production web content identity counts are invalid.");
  }
  parseSha256(identity.sha256, "Production web content SHA-256");
}

function validateWebBrowserRoutes(candidate, expected) {
  if (
    !Array.isArray(candidate) ||
    !Array.isArray(expected) ||
    candidate.length !== expected.length ||
    candidate.some((route, index) => route !== expected[index])
  ) {
    throw new TypeError("Production web browser routes are inconsistent.");
  }
  return Object.freeze([...candidate]);
}

function validateWebEntryAssets(candidate, assetPaths) {
  if (!Array.isArray(candidate) || candidate.length < 1) {
    throw new TypeError("Production web entry assets are invalid.");
  }
  const parsed = candidate.map((path) => parseRelativePath(path, "Web entry asset path", false));
  const sorted = [...parsed].sort((left, right) => left.localeCompare(right));
  if (
    !sameArray(parsed, sorted) ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((path) => !assetPaths.has(path)) ||
    !parsed.some((path) => extname(path).toLowerCase() === ".js")
  ) {
    throw new TypeError("Production web entry assets are inconsistent.");
  }
  return Object.freeze(parsed);
}

function validateProductionWebIndex(content, manifest) {
  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new TypeError("Production web index is not valid UTF-8.", { cause });
  }
  const escapedVersion = manifest.packageVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const versionPattern = new RegExp(
    `<meta\\s+name=["']hostdeck-package-version["']\\s+content=["']${escapedVersion}["']\\s*/?>`,
    "gu"
  );
  if (
    countMatches(html, versionPattern) !== 1 ||
    countMatches(html, /<meta\b[^>]*\bname=["']hostdeck-package-version["'][^>]*>/giu) !== 1
  ) {
    throw new TypeError("Production web index package-version marker is invalid.");
  }
  if (
    /(?:https?:|wss?:|\/src\/|@vite\/client|vite\/hmr|sourceMappingURL)/iu.test(html) ||
    /<base\b/iu.test(html) ||
    /\son[a-z][a-z0-9_-]*\s*=/iu.test(html)
  ) {
    throw new TypeError("Production web index contains a source, development, or external reference.");
  }
  assertSelectedProductionDocument(html, "Production web index");
  const references = [];
  for (const match of html.matchAll(/(?:^|[\s<])(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    const reference = match[1] ?? "";
    if (!reference.startsWith("/assets/")) {
      throw new TypeError("Production web index entry references are inconsistent.");
    }
    references.push(reference.slice(1));
  }
  references.sort((left, right) => left.localeCompare(right));
  if (!sameArray(references, manifest.entryAssets)) {
    throw new TypeError("Production web index entry references are inconsistent.");
  }
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/giu)];
  if (
    scriptTags.length !== 1 ||
    scriptTags.some(
      (match) =>
        !/(?:^|\s)type=["']module["'](?:\s|$)/u.test(match[1]) ||
        !/(?:^|\s)src=["']\/assets\//u.test(match[1])
    )
  ) {
    throw new TypeError("Production web index contains inline executable script.");
  }
}

function assertSelectedProductionDocument(html, label) {
  const selectedElements = [
    [/<!doctype\s+html\s*>/giu, /<!doctype\b/giu],
    [/<html\s+lang=["']en["']\s*>/giu, /<html\b/giu],
    [/<meta\s+charset=["']UTF-8["']\s*\/?>/giu, /<meta\b[^>]*\bcharset\s*=/giu],
    [
      /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content["']\s*\/?>/giu,
      /<meta\b[^>]*\bname=["']viewport["'][^>]*>/giu
    ],
    [
      /<meta\s+name=["']theme-color["']\s+content=["']#121313["']\s*\/?>/giu,
      /<meta\b[^>]*\bname=["']theme-color["'][^>]*>/giu
    ],
    [/<title>HostDeck<\/title>/giu, /<title\b/giu],
    [/<div\s+id=["']root["']\s*><\/div>/giu, /<[a-z][^>]*\bid=["']root["'][^>]*>/giu]
  ];
  if (
    selectedElements.some(
      ([expected, family]) =>
        countMatches(html, expected) !== 1 || countMatches(html, family) !== 1
    )
  ) {
    throw new TypeError(`${label} document structure is invalid.`);
  }
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function validateWebDescriptor(candidate, packageVersion) {
  const descriptor = assertRecord(candidate, "Production package web descriptor");
  assertExactKeys(
    descriptor,
    [
      "assetCount",
      "browserRoutes",
      "bytes",
      "fileCount",
      "indexPath",
      "manifestPath",
      "manifestSha256",
      "manifestSize",
      "packageVersion",
      "root",
      "schemaVersion",
      "sha256",
      "viteVersion"
    ],
    "Production package web descriptor"
  );
  if (
    descriptor.root !== "web" ||
    descriptor.manifestPath !== `web/${productionWebManifestName}` ||
    descriptor.indexPath !== "web/index.html" ||
    descriptor.schemaVersion !== productionWebManifestSchemaVersion ||
    descriptor.packageVersion !== packageVersion ||
    descriptor.viteVersion !== productionWebViteVersion ||
    !Number.isSafeInteger(descriptor.assetCount) ||
    descriptor.assetCount < 1 ||
    descriptor.assetCount > productionWebLimits.maxAssetFiles ||
    !Number.isSafeInteger(descriptor.fileCount) ||
    descriptor.fileCount !== descriptor.assetCount + 1 ||
    !Number.isSafeInteger(descriptor.bytes) ||
    descriptor.bytes < 1 ||
    descriptor.bytes >
      productionWebLimits.maxAssetTotalBytes + productionWebLimits.indexMaxBytes ||
    !Number.isSafeInteger(descriptor.manifestSize) ||
    descriptor.manifestSize < 1 ||
    descriptor.manifestSize > productionWebLimits.manifestMaxBytes
  ) {
    throw new TypeError("Production package web descriptor is inconsistent.");
  }
  validateWebBrowserRoutes(descriptor.browserRoutes, productionWebBrowserRoutes);
  parseSha256(descriptor.sha256, "Production web content SHA-256");
  parseSha256(descriptor.manifestSha256, "Production web manifest SHA-256");
}

function assertWebDescriptorIdentity(expected, actual) {
  validateWebDescriptor(expected, actual.packageVersion);
  for (const key of [
    "assetCount",
    "bytes",
    "fileCount",
    "indexPath",
    "manifestPath",
    "manifestSha256",
    "manifestSize",
    "packageVersion",
    "root",
    "schemaVersion",
    "sha256",
    "viteVersion"
  ]) {
    if (expected[key] !== actual[key]) {
      throw new TypeError(`Production web descriptor ${key} is inconsistent.`);
    }
  }
  validateWebBrowserRoutes(expected.browserRoutes, actual.browserRoutes);
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
  if (
    sourceCount !== productionPackageSourceCount ||
    outputIdentity.count !== compiledCount + packages.length + 1
  ) {
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

function validateCommand(command, packageVersion) {
  const value = assertRecord(command, "CLI command descriptor");
  assertExactKeys(
    value,
    ["name", "package", "path", "sha256", "shebang", "size", "version"],
    "CLI command descriptor"
  );
  if (
    value.name !== "codexdeck" ||
    value.package !== "@hostdeck/cli" ||
    value.path !== "dist/shell.js" ||
    value.shebang !== "#!/usr/bin/env node" ||
    value.version !== packageVersion ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new TypeError("CLI command descriptor is inconsistent.");
  }
  parseRelativePath(value.path, "CLI command path", false);
  parseSha256(value.sha256, "CLI command SHA-256");
}

function validateServiceHost(serviceHost, packageVersion) {
  const value = assertRecord(serviceHost, "Service-host descriptor");
  assertExactKeys(
    value,
    ["package", "path", "sha256", "size", "version"],
    "Service-host descriptor"
  );
  if (
    value.package !== "@hostdeck/cli" ||
    value.path !== "dist/service-host.js" ||
    value.version !== packageVersion ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new TypeError("Service-host descriptor is inconsistent.");
  }
  parseRelativePath(value.path, "Service-host path", false);
  parseSha256(value.sha256, "Service-host SHA-256");
}

function validateExecutables(executables, commandPath) {
  if (!Array.isArray(executables)) throw new TypeError("Executable inventory must be an array.");
  const parsed = executables.map((path) => parseRelativePath(path, "Executable path", false));
  const sorted = [...parsed].sort((left, right) => left.localeCompare(right));
  if (!sameArray(parsed, sorted) || new Set(parsed).size !== parsed.length) {
    throw new TypeError("Executable inventory must be sorted and unique.");
  }
  if (!parsed.includes(commandPath)) {
    throw new TypeError("CLI command is absent from the executable inventory.");
  }
  if (parsed.some((path) => (path.startsWith("dist/") && path !== commandPath) || path === productionPackageVerifierName)) {
    throw new TypeError("Undeclared HostDeck-owned files cannot be executable.");
  }
}

function validateNativeManifest(nativeModules, executableFiles) {
  if (!Array.isArray(nativeModules) || nativeModules.length !== 2) {
    throw new TypeError("Required native-module inventory must contain exactly two entries.");
  }
  const expected = ["better-sqlite3", "fs-native-extensions"];
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
    if (descriptor.name === "@hostdeck/cli") expectedKeys.push("bin");
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
        stableJson({ ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } }) ||
      (descriptor.name === "@hostdeck/cli"
        ? stableJson(runtimeManifest.bin) !== stableJson({ codexdeck: "./dist/shell.js" })
        : runtimeManifest.bin !== undefined)
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

function verifyCommand(root, command, executableFiles) {
  const path = resolveContained(root, command.path, "CLI command path");
  const stats = lstatOrNull(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.nlink !== 1 ||
    !executableFiles.includes(command.path)
  ) {
    throw new TypeError("CLI command target is missing or not executable.");
  }
  assertFileMode(stats.mode, command.path, true);
  const content = readFileSync(path);
  if (
    content.length !== command.size ||
    sha256Hex(content) !== command.sha256 ||
    !content.subarray(0, 20).equals(Buffer.from(`${command.shebang}\n`))
  ) {
    throw new TypeError("CLI command target identity is invalid.");
  }
  const text = content.toString("utf8");
  if (/\b(?:ts-node|tsx)\b|from\s+["'][^"']+\.ts["']/u.test(text)) {
    throw new TypeError("CLI command target depends on a source runtime loader.");
  }
}

function verifyServiceHost(root, serviceHost, executableFiles) {
  const path = resolveContained(root, serviceHost.path, "Service-host path");
  const stats = lstatOrNull(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.nlink !== 1 ||
    executableFiles.includes(serviceHost.path)
  ) {
    throw new TypeError("Service-host module is missing or executable.");
  }
  assertFileMode(stats.mode, serviceHost.path, false);
  const content = readFileSync(path);
  if (
    content.length !== serviceHost.size ||
    sha256Hex(content) !== serviceHost.sha256 ||
    content.subarray(0, 2).equals(Buffer.from("#!")) ||
    /\b(?:ts-node|tsx)\b|from\s+["'][^"']+\.ts["']/u.test(
      content.toString("utf8")
    )
  ) {
    throw new TypeError("Service-host module identity is invalid.");
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

function verifyNoOwnedExecutables(root, packages, executableFiles, commandPath) {
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
    if (
      ownedDistRoots.some((distRoot) => isInside(distRoot, path)) &&
      executable !== commandPath
    ) {
      throw new TypeError("Undeclared HostDeck-owned compiled output cannot be executable.");
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

function listWebRegularFiles(root, expectedAssetDirectories) {
  const files = [];
  let assetBytes = 0;
  let assetEntries = 0;
  let assetFiles = 0;
  function visit(directory, relativeDirectory, depth) {
    if (depth > productionWebLimits.maxAssetDepth) {
      throw new TypeError("Production web asset depth exceeds the configured limit.");
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = toPortablePath(
        relativeDirectory.length === 0 ? entry.name : join(relativeDirectory, entry.name)
      );
      parseRelativePath(relativePath, "Production web inventory path", false);
      if (relativePath.startsWith("assets/")) {
        assetEntries += 1;
        if (assetEntries > productionWebLimits.maxAssetEntries) {
          throw new TypeError("Production web asset entries exceed the configured limit.");
        }
      }
      const stats = lstatSync(path);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new TypeError(`Production web tree cannot contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        if (realpathSync(path) !== path) {
          throw new TypeError(`Production web directory is noncanonical: ${relativePath}`);
        }
        if (
          relativePath.startsWith("assets/") &&
          !expectedAssetDirectories.has(relativePath)
        ) {
          throw new TypeError(
            "Production web directory inventory does not match its manifest."
          );
        }
        assertDirectoryMode(stats.mode, `web/${relativePath}`);
        visit(path, relativePath, relativePath.startsWith("assets/") ? depth + 1 : depth);
        continue;
      }
      if (!entry.isFile() || !stats.isFile() || stats.nlink !== 1) {
        throw new TypeError(`Production web entry is not one regular file: ${relativePath}`);
      }
      assertFileMode(stats.mode, `web/${relativePath}`, false);
      if (relativePath.startsWith("assets/")) {
        assetFiles += 1;
        assetBytes += stats.size;
        if (
          stats.size > productionWebLimits.maxAssetFileBytes ||
          assetFiles > productionWebLimits.maxAssetFiles ||
          assetBytes > productionWebLimits.maxAssetTotalBytes
        ) {
          throw new TypeError("Production web asset size or count exceeds the configured limit.");
        }
      } else if (
        relativePath === "index.html" &&
        stats.size > productionWebLimits.indexMaxBytes
      ) {
        throw new TypeError("Production web index exceeds the configured limit.");
      }
      files.push(relativePath);
    }
  }
  visit(root, "", 0);
  return files.sort((left, right) => left.localeCompare(right));
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

function assertSafeWebAssetPath(path) {
  if (!path.split("/").every((segment) => safeWebAssetSegmentPattern.test(segment))) {
    throw new TypeError(`Web asset path contains an unsafe segment: ${path}`);
  }
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
      `HostDeck package verified: ${result.entryCount} entries, ${result.outputCount} owned outputs, ${result.webFileCount} web files (${result.webBytes} bytes, sha256:${result.webSha256}), package sha256:${result.contentSha256}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HostDeck package verification failed: ${message.slice(0, 500)}`);
    process.exitCode = 1;
  }
}
