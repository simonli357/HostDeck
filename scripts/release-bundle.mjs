import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyNativeCiEvidenceFile } from "./native-ci-evidence.mjs";
import { verifySupplyChainMetadata } from "./supply-chain-metadata.mjs";
import {
  productionPackageManifestName,
  sha256Hex,
  verifyProductionPackage
} from "./verify-production-package.mjs";

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const maximumAssetBytes = 4 * 1024 * 1024 * 1024;
const maximumArchiveEntries = 100_000;
const releaseIndexName = "release.json";

const metadataAssets = Object.freeze([
  Object.freeze({ kind: "package_checksums", source: "SHA256SUMS", suffix: "package.SHA256SUMS" }),
  Object.freeze({ kind: "sbom", source: "hostdeck.cdx.json", suffix: "cdx.json" }),
  Object.freeze({ kind: "provenance", source: "hostdeck.provenance.json", suffix: "provenance.json" }),
  Object.freeze({ kind: "licenses", source: "licenses.json", suffix: "licenses.json" }),
  Object.freeze({ kind: "metadata", source: "metadata.json", suffix: "metadata.json" })
]);

export const releaseBundleSchemaVersion = 1;

export function createDeterministicPackageArchive(packageRoot, archivePath) {
  if (process.platform !== "linux") {
    throw new TypeError("Release archive generation supports Ubuntu/Linux only.");
  }
  const sourceRoot = resolveRealDirectory(packageRoot, "Package root");
  const outputPath = resolve(archivePath);
  if (basename(outputPath).startsWith(".") || !outputPath.endsWith(".tar.gz")) {
    throw new TypeError("Release archive path is invalid.");
  }
  const outputParent = realpathSync(dirname(outputPath));
  if (join(outputParent, basename(outputPath)) !== outputPath || existsSync(outputPath)) {
    throw new TypeError("Release archive output is invalid or already exists.");
  }
  const temporaryTar = join(outputParent, `.${basename(outputPath, ".gz")}.${process.pid}.tmp`);
  if (existsSync(temporaryTar) || existsSync(`${temporaryTar}.gz`)) {
    throw new TypeError("Release archive staging path is occupied.");
  }
  try {
    runCommand("tar", [
      "--sort=name",
      "--format=posix",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "--transform=s|^\\.|hostdeck|",
      "-C",
      sourceRoot,
      "-cf",
      temporaryTar,
      "."
    ], "Deterministic tar creation");
    runCommand("gzip", ["-n", "-9", "--", temporaryTar], "Deterministic gzip creation");
    const compressedPath = `${temporaryTar}.gz`;
    renameSync(compressedPath, outputPath);
    chmodSync(outputPath, 0o644);
    return fileDescriptor("archive", outputPath);
  } catch (error) {
    rmSync(temporaryTar, { force: true });
    rmSync(`${temporaryTar}.gz`, { force: true });
    rmSync(outputPath, { force: true });
    throw error;
  }
}

export function generateReleaseBundle(options) {
  const paths = resolveReleasePaths(options, false);
  if (existsSync(paths.outputRoot)) throw new TypeError("Release bundle output already exists.");
  const snapshot = inspectReleaseInputs(paths);
  const stagingRoot = mkdtempSync(join(paths.outputParent, ".hostdeck-release-stage-"));
  try {
    writeReleaseAssets(stagingRoot, paths, snapshot);
    verifyReleaseDirectory(stagingRoot, paths, snapshot);
    renameSync(stagingRoot, paths.outputRoot);
    return releaseSummary(snapshot, paths.outputRoot);
  } catch (error) {
    rmSync(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}

export function verifyReleaseBundle(options) {
  const paths = resolveReleasePaths(options, true);
  const snapshot = inspectReleaseInputs(paths);
  verifyReleaseDirectory(paths.outputRoot, paths, snapshot);
  return releaseSummary(snapshot, paths.outputRoot);
}

function inspectReleaseInputs(paths) {
  const verification = verifyProductionPackage(paths.packageRoot);
  const manifestBytes = readBoundedRegularFile(
    join(paths.packageRoot, productionPackageManifestName),
    512 * 1024,
    "Package manifest"
  );
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (cause) {
    throw new TypeError("Package manifest cannot be read for release bundling.", { cause });
  }
  if (
    typeof manifest.packageVersion !== "string" ||
    !exactVersionPattern.test(manifest.packageVersion) ||
    manifest.target?.id !== "linux-x64" ||
    manifest.target?.platform !== "linux" ||
    manifest.target?.architecture !== "x64" ||
    manifest.target?.publicPackageKind !== "linux_archive" ||
    typeof manifest.source?.commit !== "string" ||
    !commitPattern.test(manifest.source.commit) ||
    !sha256Pattern.test(manifest.content?.sha256) ||
    !sha256Pattern.test(manifest.manifestSha256)
  ) {
    throw new TypeError("Package identity is not an Ubuntu release candidate.");
  }
  if (paths.tag !== `v${manifest.packageVersion}`) {
    throw new TypeError("Release tag does not match the package version.");
  }
  const repositoryCommit = readRepositoryCommit(paths.repositoryRoot);
  if (manifest.source.commit !== repositoryCommit) {
    throw new TypeError("Package source does not match the checked-out release commit.");
  }
  const evidence = verifyNativeCiEvidenceFile(paths.nativeEvidencePath);
  const evidenceSha256 = sha256Hex(
    readBoundedRegularFile(paths.nativeEvidencePath, 64 * 1024, "Native CI evidence")
  );
  if (
    evidence.target !== "linux-x64" ||
    evidence.workflow.event !== "push" ||
    evidence.workflow.name !== "release" ||
    evidence.source.commit !== repositoryCommit
  ) {
    throw new TypeError("Native evidence is not from this Ubuntu release run.");
  }
  const metadata = verifySupplyChainMetadata({
    nativeEvidencePath: paths.nativeEvidencePath,
    outputRoot: paths.metadataRoot,
    packageRoot: paths.packageRoot,
    repositoryRoot: paths.repositoryRoot
  });
  if (
    metadata.target !== "linux-x64" ||
    metadata.packageContentSha256 !== manifest.content.sha256
  ) {
    throw new TypeError("Supply-chain metadata does not match the release package.");
  }
  const baseName = `hostdeck-${manifest.packageVersion}-linux-x64`;
  return Object.freeze({
    baseName,
    evidence,
    evidenceSha256,
    manifest,
    metadata,
    verification
  });
}

function writeReleaseAssets(root, paths, snapshot) {
  const archiveName = `${snapshot.baseName}.tar.gz`;
  const archive = createDeterministicPackageArchive(paths.packageRoot, join(root, archiveName));
  writeOwnedFile(
    join(root, `${archiveName}.sha256`),
    `${archive.sha256}  ${archiveName}\n`
  );
  for (const descriptor of metadataAssets) {
    writeOwnedFile(
      join(root, `${snapshot.baseName}.${descriptor.suffix}`),
      readBoundedRegularFile(
        join(paths.metadataRoot, descriptor.source),
        16 * 1024 * 1024,
        `Release ${descriptor.kind}`
      )
    );
  }
  const evidenceName = `${snapshot.baseName}.native-ci.json`;
  const evidenceBytes = readBoundedRegularFile(
    paths.nativeEvidencePath,
    64 * 1024,
    "Native CI evidence"
  );
  writeOwnedFile(join(root, evidenceName), evidenceBytes);
  writeOwnedFile(
    join(root, `${evidenceName}.sha256`),
    `${sha256Hex(evidenceBytes)}  ${evidenceName}\n`
  );
  writeOwnedFile(
    join(root, `${snapshot.baseName}.release-notes.md`),
    createReleaseNotes(snapshot, archiveName)
  );
  const assets = collectAssetDescriptors(root);
  const index = createReleaseIndex(snapshot, paths.tag, assets);
  writeOwnedFile(join(root, releaseIndexName), serializeJson(index));
}

function verifyReleaseDirectory(root, paths, snapshot) {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("Release bundle must be one real directory.");
  }
  const expectedNames = expectedReleaseAssetNames(snapshot.baseName);
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name)
  );
  if (
    entries.length !== expectedNames.length ||
    entries.some(
      (entry, index) =>
        entry.name !== expectedNames[index] ||
        !entry.isFile() ||
        entry.isSymbolicLink()
    )
  ) {
    throw new TypeError("Release bundle asset inventory is invalid.");
  }
  for (const entry of entries) {
    const fileStats = lstatSync(join(root, entry.name));
    if (
      !fileStats.isFile() ||
      fileStats.nlink !== 1 ||
      (fileStats.mode & 0o777) !== 0o644 ||
      fileStats.size < 1 ||
      fileStats.size > maximumAssetBytes
    ) {
      throw new TypeError(`Release asset identity is invalid: ${entry.name}`);
    }
  }

  const archiveName = `${snapshot.baseName}.tar.gz`;
  const archivePath = join(root, archiveName);
  const archive = fileDescriptor("archive", archivePath);
  requireExactText(
    join(root, `${archiveName}.sha256`),
    `${archive.sha256}  ${archiveName}\n`,
    "Archive checksum"
  );
  for (const descriptor of metadataAssets) {
    requireExactBytes(
      join(root, `${snapshot.baseName}.${descriptor.suffix}`),
      readBoundedRegularFile(
        join(paths.metadataRoot, descriptor.source),
        16 * 1024 * 1024,
        `Release ${descriptor.kind}`
      ),
      `Release ${descriptor.kind}`
    );
  }
  const evidenceName = `${snapshot.baseName}.native-ci.json`;
  const evidenceBytes = readBoundedRegularFile(
    paths.nativeEvidencePath,
    64 * 1024,
    "Native CI evidence"
  );
  requireExactBytes(join(root, evidenceName), evidenceBytes, "Release native evidence");
  requireExactText(
    join(root, `${evidenceName}.sha256`),
    `${sha256Hex(evidenceBytes)}  ${evidenceName}\n`,
    "Native evidence checksum"
  );
  requireExactText(
    join(root, `${snapshot.baseName}.release-notes.md`),
    createReleaseNotes(snapshot, archiveName),
    "Release notes"
  );
  const assets = collectAssetDescriptors(root);
  const expectedIndex = serializeJson(createReleaseIndex(snapshot, paths.tag, assets));
  requireExactText(join(root, releaseIndexName), expectedIndex, "Release index");
  verifyArchivePayload(archivePath, snapshot, paths.outputParent);
}

function verifyArchivePayload(archivePath, snapshot, temporaryParent) {
  const listing = runCommand(
    "tar",
    ["-tzf", archivePath],
    "Release archive listing",
    16 * 1024 * 1024
  ).stdout;
  const entries = listing.split("\n").filter((entry) => entry !== "");
  if (
    entries.length < 1 ||
    entries.length > maximumArchiveEntries ||
    entries.some(
      (entry) =>
        entry.length > 1_024 ||
        (entry !== "hostdeck" &&
          entry !== "hostdeck/" &&
          !entry.startsWith("hostdeck/")) ||
        entry.includes("\0") ||
        entry.split("/").includes("..")
    )
  ) {
    throw new TypeError("Release archive paths are invalid.");
  }
  const extractionRoot = mkdtempSync(join(temporaryParent, ".hostdeck-release-extract-"));
  try {
    runCommand(
      "tar",
      [
        "--extract",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        extractionRoot,
        "--no-same-owner",
        "--same-permissions"
      ],
      "Release archive extraction"
    );
    const extractedEntries = readdirSync(extractionRoot, { withFileTypes: true });
    if (
      extractedEntries.length !== 1 ||
      extractedEntries[0].name !== "hostdeck" ||
      !extractedEntries[0].isDirectory() ||
      extractedEntries[0].isSymbolicLink()
    ) {
      throw new TypeError("Release archive root is invalid.");
    }
    const verification = verifyProductionPackage(join(extractionRoot, "hostdeck"));
    if (
      verification.contentSha256 !== snapshot.verification.contentSha256 ||
      verification.entryCount !== snapshot.verification.entryCount ||
      verification.packageVersion !== snapshot.verification.packageVersion
    ) {
      throw new TypeError("Release archive payload does not match the verified package.");
    }
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}

function createReleaseIndex(snapshot, tag, assets) {
  return Object.freeze({
    schemaVersion: releaseBundleSchemaVersion,
    name: "hostdeck-ubuntu-release",
    tag,
    package: {
      version: snapshot.manifest.packageVersion,
      target: snapshot.manifest.target.id,
      sourceCommit: snapshot.manifest.source.commit,
      contentSha256: snapshot.manifest.content.sha256,
      manifestSha256: snapshot.manifest.manifestSha256
    },
    nativeCi: {
      workflowName: snapshot.evidence.workflow.name,
      runId: snapshot.evidence.workflow.run_id,
      runAttempt: snapshot.evidence.workflow.run_attempt,
      evidenceSha256: snapshot.evidenceSha256
    },
    supplyChainMetadataSha256: snapshot.metadata.metadataSha256,
    assets
  });
}

function collectAssetDescriptors(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== releaseIndexName)
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || !assetNamePattern.test(entry.name)) {
        throw new TypeError("Release asset name or type is invalid.");
      }
      return fileDescriptor(assetKind(entry.name), join(root, entry.name));
    })
    .sort((left, right) => compareText(left.name, right.name));
}

function assetKind(name) {
  if (name.endsWith(".tar.gz")) return "archive";
  if (name.endsWith(".tar.gz.sha256")) return "archive_checksum";
  if (name.endsWith(".package.SHA256SUMS")) return "package_checksums";
  if (name.endsWith(".cdx.json")) return "sbom";
  if (name.endsWith(".provenance.json")) return "provenance";
  if (name.endsWith(".licenses.json")) return "licenses";
  if (name.endsWith(".metadata.json")) return "metadata";
  if (name.endsWith(".native-ci.json")) return "native_ci";
  if (name.endsWith(".native-ci.json.sha256")) return "native_ci_checksum";
  if (name.endsWith(".release-notes.md")) return "release_notes";
  throw new TypeError("Release asset kind is invalid.");
}

function expectedReleaseAssetNames(baseName) {
  return [
    `${baseName}.cdx.json`,
    `${baseName}.licenses.json`,
    `${baseName}.metadata.json`,
    `${baseName}.native-ci.json`,
    `${baseName}.native-ci.json.sha256`,
    `${baseName}.package.SHA256SUMS`,
    `${baseName}.provenance.json`,
    `${baseName}.release-notes.md`,
    `${baseName}.tar.gz`,
    `${baseName}.tar.gz.sha256`,
    releaseIndexName
  ].sort(compareText);
}

function createReleaseNotes(snapshot, archiveName) {
  return `# HostDeck ${snapshot.manifest.packageVersion}\n\nUbuntu 24.04 x64 package.\n\nVerify before installation:\n\n\`\`\`bash\ngh attestation verify ${archiveName} --repo simonli357/HostDeck\nsha256sum -c ${archiveName}.sha256\n\`\`\`\n\nExtract with \`tar -xzf ${archiveName}\`, then run \`./hostdeck/bin/codexdeck service install\` with \`HOSTDECK_CODEX_BIN\` set to the absolute exact Codex 0.147.0 executable.\n`;
}

function resolveReleasePaths(options, outputMustExist) {
  const value = exactRecord(
    options,
    ["metadataRoot", "nativeEvidencePath", "outputRoot", "packageRoot", "repositoryRoot", "tag"],
    "Release bundle paths"
  );
  const packageRoot = resolveRealDirectory(value.packageRoot, "Package root");
  const metadataRoot = resolveRealDirectory(value.metadataRoot, "Metadata root");
  const nativeEvidencePath = resolveRealFile(value.nativeEvidencePath, "Native evidence");
  const repositoryRoot = resolveRealDirectory(value.repositoryRoot, "Repository root");
  const tag = parseTag(value.tag);
  const requestedOutput = resolve(value.outputRoot);
  const requestedParent = dirname(requestedOutput);
  if (outputMustExist) {
    if (!existsSync(requestedParent)) throw new TypeError("Release output parent is missing.");
  } else {
    mkdirSync(requestedParent, { mode: 0o755, recursive: true });
  }
  const outputParent = realpathSync(requestedParent);
  const outputRoot = join(outputParent, basename(requestedOutput));
  if (
    outputRoot !== requestedOutput ||
    basename(outputRoot).startsWith(".") ||
    isInside(packageRoot, outputRoot) ||
    isInside(metadataRoot, outputRoot)
  ) {
    throw new TypeError("Release output path is invalid.");
  }
  if (outputMustExist && !existsSync(outputRoot)) {
    throw new TypeError("Release bundle output is missing.");
  }
  return Object.freeze({
    metadataRoot,
    nativeEvidencePath,
    outputParent,
    outputRoot,
    packageRoot,
    repositoryRoot,
    tag
  });
}

function parseTag(candidate) {
  if (typeof candidate !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate)) {
    throw new TypeError("Release tag is invalid.");
  }
  return candidate;
}

function readRepositoryCommit(root) {
  const result = runCommand(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Release repository commit",
    1_024,
    root
  ).stdout.trim();
  if (!commitPattern.test(result)) throw new TypeError("Release repository commit is invalid.");
  return result;
}

function resolveRealDirectory(candidate, label) {
  const requested = resolve(candidate);
  const stats = lstatSync(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError(`${label} must be one real directory.`);
  }
  return realpathSync(requested);
}

function resolveRealFile(candidate, label) {
  const requested = resolve(candidate);
  const stats = lstatSync(requested);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new TypeError(`${label} must be one regular non-linked file.`);
  }
  return realpathSync(requested);
}

function readBoundedRegularFile(path, maximumBytes, label) {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size < 1 ||
    stats.size > maximumBytes
  ) {
    throw new TypeError(`${label} identity is invalid.`);
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== stats.size) throw new TypeError(`${label} changed while read.`);
  return bytes;
}

function writeOwnedFile(path, content) {
  writeFileSync(path, content, { flag: "wx", mode: 0o644 });
  chmodSync(path, 0o644);
}

function fileDescriptor(kind, path) {
  const bytes = readBoundedRegularFile(path, maximumAssetBytes, "Release asset");
  return Object.freeze({
    kind,
    name: basename(path),
    sha256: sha256Hex(bytes),
    size: bytes.byteLength
  });
}

function requireExactBytes(path, expected, label) {
  const observed = readBoundedRegularFile(path, maximumAssetBytes, label);
  if (!observed.equals(expected)) throw new TypeError(`${label} is inconsistent.`);
}

function requireExactText(path, expected, label) {
  const bytes = readBoundedRegularFile(path, maximumAssetBytes, label);
  let observed;
  try {
    observed = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError(`${label} is not UTF-8.`, { cause });
  }
  if (observed !== expected) throw new TypeError(`${label} is inconsistent.`);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function releaseSummary(snapshot, outputRoot) {
  return Object.freeze({
    assetCount: expectedReleaseAssetNames(snapshot.baseName).length,
    outputRoot,
    packageContentSha256: snapshot.manifest.content.sha256,
    sourceCommit: snapshot.manifest.source.commit,
    tag: `v${snapshot.manifest.packageVersion}`,
    target: snapshot.manifest.target.id,
    version: snapshot.manifest.packageVersion
  });
}

function runCommand(command, args, label, maxBuffer = 1024 * 1024, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH, TZ: "UTC" },
    maxBuffer,
    shell: false,
    timeout: 5 * 60_000,
    windowsHide: true
  });
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== ""
  ) {
    throw new Error(`${label} failed.`);
  }
  return result;
}

function exactRecord(candidate, keys, label) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(candidate).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid.`);
  }
  return candidate;
}

function isInside(root, target) {
  const candidate = relative(root, target);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCliArguments(arguments_) {
  if (arguments_.length !== 13 || !["generate", "verify"].includes(arguments_[0])) {
    throw new TypeError(
      "Usage: release-bundle.mjs <generate|verify> --package <path> --metadata <path> --evidence <path> --output <path> --repository <path> --tag <vX.Y.Z>"
    );
  }
  const values = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--evidence", "--metadata", "--output", "--package", "--repository", "--tag"].includes(flag) ||
      values[flag] !== undefined
    ) {
      throw new TypeError("Release bundle command flags are invalid.");
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== 6) {
    throw new TypeError("Release bundle command flags are incomplete.");
  }
  return {
    command: arguments_[0],
    options: {
      metadataRoot: values["--metadata"],
      nativeEvidencePath: values["--evidence"],
      outputRoot: values["--output"],
      packageRoot: values["--package"],
      repositoryRoot: values["--repository"],
      tag: values["--tag"]
    }
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, options } = parseCliArguments(process.argv.slice(2));
    const result = command === "generate" ? generateReleaseBundle(options) : verifyReleaseBundle(options);
    process.stdout.write(
      `HostDeck release bundle ${command === "generate" ? "generated" : "verified"}: ${result.tag}, ${result.assetCount} assets.\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof TypeError ? error.message : "Release bundle command failed before publication."}\n`
    );
    process.exitCode = 1;
  }
}
