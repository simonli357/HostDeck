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
  createProductionWebManifest,
  inspectProductionPackageTree,
  productionPackageManifestName,
  productionPackageSourceCount,
  productionPackageVerifierName,
  productionWebBrowserRoutes,
  productionWebLimits,
  productionWebManifestName,
  productionWebMediaType,
  productionWebViteVersion,
  sha256Hex,
  verifyProductionPackage,
  verifyProductionWebAssets
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
  if (sources.length !== productionPackageSourceCount) {
    throw new Error(
      `Selected server/CLI closure contains ${sources.length} sources; expected exactly ${productionPackageSourceCount}.`
    );
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
  if (sourceManifest.name !== "@hostdeck/cli" && sourceManifest.bin !== undefined) {
    throw new TypeError(`${sourceManifest.name} must not declare runtime commands.`);
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
    ...(sourceManifest.name === "@hostdeck/cli"
      ? { bin: createRuntimeCliBin(sourceManifest.bin) }
      : {}),
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

function createRuntimeCliBin(candidate) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 1 ||
    candidate.codexdeck !== "./src/shell.ts"
  ) {
    throw new TypeError("@hostdeck/cli source bin metadata is invalid.");
  }
  return { codexdeck: "./dist/shell.js" };
}

export function buildProductionPackage(options = {}) {
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? defaultRepositoryRoot));
  const distRoot = join(repositoryRoot, "dist");
  const outputRoot = resolve(options.outputRoot ?? join(distRoot, "hostdeck"));
  if (
    dirname(outputRoot) !== distRoot ||
    !basename(outputRoot).startsWith("hostdeck")
  ) {
    throw new TypeError("Production package output must be one HostDeck dist child.");
  }
  const rootManifest = readJson(join(repositoryRoot, "package.json"));
  const runtime = assertBuildRuntime(repositoryRoot, rootManifest);
  const sources = selectedProductionSources(repositoryRoot);
  const sourceIdentity = computeFileIdentity(
    sources.map((path) => ({ content: readFileSync(join(repositoryRoot, path)), path }))
  );
  const sourceCounts = countSourcesByPackage(sources);
  const codex = readCodexBindingIdentity(repositoryRoot);
  const packageVersion = parseExactVersion(
    options.packageVersion ?? rootManifest.version,
    "Package version"
  );
  mkdirSync(distRoot, { mode: 0o755, recursive: true });
  const stagingRoot = mkdtempSync(join(distRoot, ".hostdeck-build-"));
  const emitRoot = join(stagingRoot, "emit");
  const deployRoot = join(stagingRoot, "deploy");
  const packageRoot = join(stagingRoot, "package");
  const webBuildRoot = join(stagingRoot, "web-build");
  try {
    compileSelectedSources(repositoryRoot, stagingRoot, emitRoot, sources);
    assertExactCompilerOutput(emitRoot, sources);
    buildProductionWebAssets({
      packageVersion,
      repositoryRoot,
      rootManifest,
      webBuildRoot
    });
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
      sourcePackageVersion: rootManifest.version,
      sourceCounts
    });
    cpSync(webBuildRoot, join(packageRoot, "web"), {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true
    });
    removePackageManagerMetadata(packageRoot);
    pruneNativeBuildIntermediates(packageRoot);
    copyFileSync(
      join(scriptDirectory, "verify-production-package.mjs"),
      join(packageRoot, productionPackageVerifierName)
    );

    const executableFiles = collectExecutableFiles(packageRoot);
    normalizePackageModes(packageRoot, new Set(executableFiles));
    const command = collectHostDeckCommand(packageRoot, packageVersion);
    const serviceHost = collectHostDeckServiceHost(packageRoot, packageVersion);
    const web = verifyProductionWebAssets(join(packageRoot, "web"), {
      browserRoutes: productionWebBrowserRoutes,
      packageVersion,
      viteVersion: productionWebViteVersion
    });
    const nativeModules = collectRequiredNativeModules(packageRoot, executableFiles);
    const ownedOutput = computeOwnedOutputIdentity(packageRoot, descriptors);
    const content = inspectProductionPackageTree(packageRoot, executableFiles);
    const manifest = {
      schemaVersion: 4,
      name: "hostdeck-production-package",
      packageVersion,
      packageManager: `pnpm@${runtime.pnpm}`,
      nativeBuildPolicy: "canonical-runtime-binary-only",
      runtime,
      codex,
      command,
      serviceHost,
      source: { count: sourceIdentity.count, sha256: sourceIdentity.sha256 },
      output: { count: ownedOutput.count, sha256: ownedOutput.sha256 },
      content,
      packages: descriptors,
      nativeModules,
      executableFiles,
      web,
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
      sourceCount: sources.length,
      webBytes: web.bytes,
      webFileCount: web.fileCount,
      webSha256: web.sha256
    });
  } finally {
    removeTree(stagingRoot);
  }
}

function collectHostDeckServiceHost(root, packageVersion) {
  const path = "dist/service-host.js";
  const absolutePath = resolve(root, path);
  const stats = lstatSync(absolutePath);
  const content = readFileSync(absolutePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644 ||
    content.subarray(0, 2).equals(Buffer.from("#!")) ||
    /\b(?:ts-node|tsx)\b|from\s+["'][^"']+\.ts["']/u.test(
      content.toString("utf8")
    )
  ) {
    throw new Error("Production service-host module is invalid.");
  }
  return Object.freeze({
    package: "@hostdeck/cli",
    path,
    sha256: sha256Hex(content),
    size: content.length,
    version: packageVersion
  });
}

function collectHostDeckCommand(root, packageVersion) {
  const manifest = readJson(join(root, "package.json"));
  if (
    manifest.name !== "@hostdeck/cli" ||
    manifest.version !== packageVersion ||
    manifest.bin === null ||
    typeof manifest.bin !== "object" ||
    Array.isArray(manifest.bin) ||
    Object.keys(manifest.bin).length !== 1 ||
    manifest.bin.codexdeck !== "./dist/shell.js"
  ) {
    throw new Error("Production CLI command metadata is invalid.");
  }
  const path = "dist/shell.js";
  const absolutePath = resolve(root, path);
  const stats = lstatSync(absolutePath);
  const content = readFileSync(absolutePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o755 ||
    !content.subarray(0, 20).equals(Buffer.from("#!/usr/bin/env node\n"))
  ) {
    throw new Error("Production CLI command target is invalid.");
  }
  return Object.freeze({
    name: "codexdeck",
    package: "@hostdeck/cli",
    path,
    sha256: sha256Hex(content),
    shebang: "#!/usr/bin/env node",
    size: content.length,
    version: packageVersion
  });
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

function buildProductionWebAssets(input) {
  const configuredViteVersion = parseExactVersion(
    input.rootManifest.devDependencies?.vite,
    "Required Vite version"
  );
  if (configuredViteVersion !== productionWebViteVersion) {
    throw new Error(
      `Production web build requires Vite ${productionWebViteVersion}; configured ${configuredViteVersion}.`
    );
  }
  const environment = createProductionWebBuildEnvironment();
  runPnpm(
    input.repositoryRoot,
    [
      "--filter",
      "@hostdeck/web",
      "exec",
      "vite",
      "build",
      "--config",
      "vite.config.ts",
      "--outDir",
      input.webBuildRoot,
      "--emptyOutDir",
      "--manifest",
      ".hostdeck-vite-manifest.json"
    ],
    "Production Vite web build",
    { env: environment.env }
  );
  const viteManifestPath = join(input.webBuildRoot, ".hostdeck-vite-manifest.json");
  const viteManifest = readBoundedJson(viteManifestPath, 1_048_576, "Vite web manifest");
  const inventory = inspectViteManifest(viteManifest, input.webBuildRoot);
  rmSync(viteManifestPath);

  const indexPath = join(input.webBuildRoot, "index.html");
  if (input.packageVersion !== input.rootManifest.version) {
    const index = readFileSync(indexPath, "utf8");
    const expected = `name="hostdeck-package-version" content="${input.rootManifest.version}"`;
    if (
      index.split(expected).length !== 2 ||
      index.includes(
        `name="hostdeck-package-version" content="${input.packageVersion}"`
      )
    ) {
      throw new Error("Production web package-version marker cannot be rewritten safely.");
    }
    writeFileSync(indexPath, index.replace(expected, `name="hostdeck-package-version" content="${input.packageVersion}"`));
  }
  const assets = inventory.assetPaths.map((path) => ({
    content: readFileSync(join(input.webBuildRoot, ...path.split("/"))),
    path
  }));
  const manifest = createProductionWebManifest({
    assets,
    browserRoutes: productionWebBrowserRoutes,
    entryAssets: inventory.entryAssets,
    index: { content: readFileSync(indexPath), path: "index.html" },
    packageVersion: input.packageVersion,
    viteVersion: productionWebViteVersion
  });
  writeJson(join(input.webBuildRoot, productionWebManifestName), manifest);
  scanProductionWebOutput(input.webBuildRoot, environment.privateValues);
}

export function inspectViteManifest(candidate, webBuildRoot) {
  if (!isPlainRecord(candidate)) throw new TypeError("Vite web manifest must be an object.");
  const records = Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right));
  if (records.length < 1 || records.length > productionWebLimits.maxAssetFiles) {
    throw new TypeError("Vite web manifest entry count is invalid.");
  }
  const allowedKeys = new Set([
    "assets",
    "css",
    "dynamicImports",
    "file",
    "imports",
    "isDynamicEntry",
    "isEntry",
    "name",
    "names",
    "src"
  ]);
  const recordKeys = new Set(records.map(([key]) => key));
  const parsedRecords = new Map();
  const claimedFiles = new Set();
  let entryKey = null;
  for (const [key, rawRecord] of records) {
    if (key.length < 1 || key.length > 4_096 || key.includes("\0")) {
      throw new TypeError("Vite manifest record key is invalid.");
    }
    if (!isPlainRecord(rawRecord)) throw new TypeError(`Vite manifest entry is invalid: ${key}`);
    if (Object.keys(rawRecord).some((field) => !allowedKeys.has(field))) {
      throw new TypeError(`Vite manifest entry fields are invalid: ${key}`);
    }
    for (const field of ["isDynamicEntry", "isEntry"]) {
      if (rawRecord[field] !== undefined && typeof rawRecord[field] !== "boolean") {
        throw new TypeError(`Vite ${field} flag is invalid: ${key}`);
      }
    }
    for (const field of ["name", "src"]) {
      if (
        rawRecord[field] !== undefined &&
        (typeof rawRecord[field] !== "string" ||
          rawRecord[field].length < 1 ||
          rawRecord[field].length > 4_096 ||
          rawRecord[field].includes("\0"))
      ) {
        throw new TypeError(`Vite ${field} value is invalid: ${key}`);
      }
    }
    if (
      rawRecord.names !== undefined &&
      (!Array.isArray(rawRecord.names) ||
        rawRecord.names.some(
          (name) => typeof name !== "string" || name.length < 1 || name.length > 4_096
        ))
    ) {
      throw new TypeError(`Vite names inventory is invalid: ${key}`);
    }
    const file = parseViteOutputPath(rawRecord.file, "Vite output file");
    if (claimedFiles.has(file)) {
      throw new TypeError(`Vite output file is claimed by multiple records: ${file}`);
    }
    claimedFiles.add(file);
    const associated = [];
    for (const field of ["css", "assets"]) {
      const paths = rawRecord[field] ?? [];
      if (!Array.isArray(paths)) throw new TypeError(`Vite ${field} inventory is invalid.`);
      const parsed = paths.map((path) => parseViteOutputPath(path, `Vite ${field} path`));
      if (new Set(parsed).size !== parsed.length) {
        throw new TypeError(`Vite ${field} inventory contains duplicates: ${key}`);
      }
      for (const path of parsed) {
        if (claimedFiles.has(path)) {
          throw new TypeError(`Vite output file is claimed by multiple records: ${path}`);
        }
        claimedFiles.add(path);
      }
      associated.push(...parsed);
    }
    const references = [];
    for (const field of ["imports", "dynamicImports"]) {
      const rawReferences = rawRecord[field] ?? [];
      if (
        !Array.isArray(rawReferences) ||
        rawReferences.some(
          (reference) => typeof reference !== "string" || !recordKeys.has(reference)
        ) ||
        new Set(rawReferences).size !== rawReferences.length
      ) {
        throw new TypeError(`Vite ${field} references are invalid.`);
      }
      references.push(...rawReferences);
    }
    if (rawRecord.isEntry === true) {
      if (
        entryKey !== null ||
        rawRecord.src !== "index.html" ||
        rawRecord.isDynamicEntry === true
      ) {
        throw new TypeError("Vite web manifest must contain one index entry.");
      }
      entryKey = key;
    }
    parsedRecords.set(key, Object.freeze({
      associated: Object.freeze(associated),
      file,
      references: Object.freeze(references)
    }));
  }
  if (entryKey === null) throw new TypeError("Vite web manifest omits its index entry.");

  const reachable = new Set();
  const pending = [entryKey];
  while (pending.length > 0) {
    const key = pending.pop();
    if (reachable.has(key)) continue;
    reachable.add(key);
    const record = parsedRecords.get(key);
    if (record === undefined) throw new TypeError("Vite manifest graph is internally inconsistent.");
    pending.push(...record.references);
  }
  if (reachable.size !== parsedRecords.size) {
    throw new TypeError("Vite web manifest contains an unreachable output record.");
  }

  const emitted = new Set();
  for (const key of reachable) {
    const record = parsedRecords.get(key);
    emitted.add(record.file);
    for (const path of record.associated) emitted.add(path);
  }
  const assetPaths = [...emitted].sort((left, right) => left.localeCompare(right));
  const actualPaths = listRegularFiles(webBuildRoot)
    .map((path) => portable(relative(webBuildRoot, path)))
    .filter((path) => path !== ".hostdeck-vite-manifest.json" && path !== "index.html")
    .sort((left, right) => left.localeCompare(right));
  if (!sameArray(assetPaths, actualPaths)) {
    throw new TypeError("Vite web manifest does not exactly describe emitted assets.");
  }
  const entryRecord = parsedRecords.get(entryKey);
  const entryAssets = [entryRecord.file, ...entryRecord.associated]
    .filter((path) => path.endsWith(".js") || path.endsWith(".css"))
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze({ assetPaths, entryAssets: Object.freeze(entryAssets) });
}

function parseViteOutputPath(candidate, label) {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("assets/") ||
    candidate.length > 4_096 ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    portable(resolve("/", candidate).slice(1)) !== candidate ||
    !/-[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9]+)+$/u.test(basename(candidate))
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  productionWebMediaType(candidate);
  return candidate;
}

export function createProductionWebBuildEnvironment(sourceEnvironment = process.env) {
  const path = sourceEnvironment.PATH;
  if (
    typeof path !== "string" ||
    path.length < 1 ||
    Buffer.byteLength(path, "utf8") > 32_768 ||
    path.includes("\0")
  ) {
    throw new TypeError("Production web build PATH is invalid.");
  }
  const privateValues = [];
  const privateKeyPattern = /(?:^VITE_|^HOSTDECK_|^CODEX_|^TAILSCALE_|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE|PROXY|SECRET|SESSION|TOKEN)/iu;
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (value === undefined) continue;
    if (privateKeyPattern.test(key)) {
      if (Buffer.byteLength(value, "utf8") >= 12) privateValues.push(Buffer.from(value));
    }
  }
  const env = {
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    NO_UPDATE_NOTIFIER: "1",
    PATH: path,
    TZ: "UTC",
    npm_config_offline: "true"
  };
  return Object.freeze({ env: Object.freeze(env), privateValues: Object.freeze(privateValues) });
}

function scanProductionWebOutput(root, privateValues) {
  const forbiddenText = [
    Buffer.from("/src/"),
    Buffer.from("@vite/client"),
    Buffer.from("vite/hmr"),
    Buffer.from("sourceMappingURL"),
    Buffer.from("BEGIN PRIVATE KEY"),
    Buffer.from("BEGIN OPENSSH PRIVATE KEY")
  ];
  for (const path of listRegularFiles(root)) {
    const relativePath = portable(relative(root, path));
    if (/\.(?:map|ts|tsx)$/iu.test(relativePath) || relativePath.startsWith(".")) {
      throw new Error(`Production web output contains source or development content: ${relativePath}.`);
    }
    const content = readFileSync(path);
    if (forbiddenText.some((token) => content.includes(token))) {
      throw new Error(`Production web output contains a source or development reference: ${relativePath}.`);
    }
    if (privateValues.some((token) => content.includes(token))) {
      throw new Error(`Production web output contains a private build value: ${relativePath}.`);
    }
  }
}

function readBoundedJson(path, maximumBytes, label) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size < 1 || stats.size > maximumBytes) {
    throw new TypeError(`${label} must be one bounded regular file.`);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))
    );
  } catch (cause) {
    throw new TypeError(`${label} is invalid JSON or UTF-8.`, { cause });
  }
}

function isPlainRecord(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
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
    if (sourceManifest.version !== input.sourcePackageVersion) {
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

function runPnpm(repositoryRoot, args, label = "pnpm", options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && existsSync(npmExecPath)) {
    return runChecked(process.execPath, [npmExecPath, ...args], repositoryRoot, label, options);
  }
  return runChecked("pnpm", args, repositoryRoot, label, options);
}

function runChecked(command, args, cwd, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...(options.env ?? process.env),
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
      `HostDeck package built: ${result.sourceCount} sources, ${result.outputCount} owned outputs, ${result.entryCount} entries, ${result.webFileCount} web files (${result.webBytes} bytes, sha256:${result.webSha256}), package sha256:${result.contentSha256}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HostDeck package build failed: ${message}`);
    process.exitCode = 1;
  }
}
