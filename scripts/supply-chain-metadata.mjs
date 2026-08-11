import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ComponentScope,
  ComponentType,
  HashAlgorithm
} from "@cyclonedx/cyclonedx-library/Enums";
import {
  Bom,
  Component,
  LicenseExpression,
  Property
} from "@cyclonedx/cyclonedx-library/Models";
import {
  JSON as CycloneDxJson,
  JsonSerializer
} from "@cyclonedx/cyclonedx-library/Serialize";
import { Spec1dot7 } from "@cyclonedx/cyclonedx-library/Spec";
import { verifyNativeCiEvidenceFile } from "./native-ci-evidence.mjs";
import {
  productionPackageManifestName,
  sha256Hex,
  stableJson,
  validateNativePackageIdentityContract,
  verifyProductionPackage
} from "./verify-production-package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})$/u;
const metadataFileNames = Object.freeze([
  "SHA256SUMS",
  "hostdeck.cdx.json",
  "hostdeck.provenance.json",
  "licenses.json",
  "metadata.json"
]);
const documentDescriptors = Object.freeze([
  Object.freeze({ kind: "checksums", path: "SHA256SUMS" }),
  Object.freeze({ kind: "licenses", path: "licenses.json" }),
  Object.freeze({ kind: "sbom", path: "hostdeck.cdx.json" }),
  Object.freeze({ kind: "provenance", path: "hostdeck.provenance.json" })
]);
const workspaceDirectories = Object.freeze([
  "packages/core",
  "packages/contracts",
  "packages/codex-adapter",
  "packages/storage",
  "packages/server",
  "packages/cli",
  "packages/web"
]);
const productEntryPackages = Object.freeze(["@hostdeck/cli", "@hostdeck/web"]);
const approvedLicenseExpressions = Object.freeze([
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT OR WTFPL)",
  "0BSD",
  "Apache-2.0",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT"
]);
const approvedLicenseSet = new Set(approvedLicenseExpressions);
const limits = Object.freeze({
  dependencyCount: 2_000,
  documentBytes: 16 * 1024 * 1024,
  packageBytes: 4 * 1024 * 1024 * 1024,
  packageFileCount: 100_000,
  packageManifestBytes: 512 * 1024
});
const knownPublicUrls = new Set([
  "http://cyclonedx.org/schema/bom-1.7.schema.json",
  "https://in-toto.io/Statement/v1",
  "https://slsa.dev/provenance/v1"
]);
const privatePathPattern = /(?:^|["'\s])(?:[A-Za-z]:[\\/](?:Users|home|tmp|private)[\\/]|\/(?:home|Users|tmp|private)\/)/u;
const privateIdentityPattern = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\.ts\.net\b|\btskey-[A-Za-z0-9_-]+|\bgh[oprsu]_[A-Za-z0-9_]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b)/iu;

export const supplyChainMetadataSchemaVersion = 1;
export const supplyChainMetadataFiles = metadataFileNames;
export const supplyChainApprovedLicenseExpressions = approvedLicenseExpressions;

export function collectPackageFileRecords(root) {
  const packageRoot = realpathSync(resolve(root));
  const records = [];
  let totalBytes = 0;

  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name)
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const portablePath = toPortablePath(
        relativeDirectory === "" ? entry.name : join(relativeDirectory, entry.name)
      );
      assertMetadataPath(portablePath, "Package file");
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        verifyContainedSymlink(packageRoot, absolutePath, portablePath);
        continue;
      }
      if (stats.isDirectory()) {
        visit(absolutePath, portablePath);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new TypeError(`Package entry is not one regular non-linked file: ${portablePath}`);
      }
      const bytes = readFileSync(absolutePath);
      totalBytes += bytes.byteLength;
      if (records.length >= limits.packageFileCount || totalBytes > limits.packageBytes) {
        throw new TypeError("Package file inventory exceeds its release bound.");
      }
      records.push(
        Object.freeze({
          path: portablePath,
          sha256: sha256Hex(bytes),
          size: bytes.byteLength
        })
      );
    }
  }

  visit(packageRoot, "");
  records.sort((left, right) => compareText(left.path, right.path));
  assertUnique(records.map(({ path }) => path), "Package file path");
  if (records.length < 1) throw new TypeError("Package file inventory is empty.");
  return deepFreeze({ bytes: totalBytes, files: records });
}

export function collectProductionDependencyGraph(repositoryRoot, packageVersion, target) {
  const root = realpathSync(resolve(repositoryRoot));
  parseExactVersion(packageVersion, "Package version");
  const platform = parseTargetPlatform(target);
  const workspaceByName = new Map();
  for (const relativeDirectory of workspaceDirectories) {
    const workspaceRoot = realpathSync(join(root, relativeDirectory));
    const manifest = readPackageManifest(workspaceRoot, "Workspace package");
    if (
      typeof manifest.name !== "string" ||
      !manifest.name.startsWith("@hostdeck/") ||
      workspaceByName.has(manifest.name)
    ) {
      throw new TypeError("Production workspace package identity is invalid.");
    }
    workspaceByName.set(manifest.name, { manifest, root: workspaceRoot });
  }
  for (const name of productEntryPackages) {
    if (!workspaceByName.has(name)) throw new TypeError("Product entry workspace is missing.");
  }

  const nodeByRef = new Map();
  const rootToRef = new Map();
  const queue = [];
  for (const [name, workspace] of workspaceByName) {
    const ref = npmPurl(name, packageVersion);
    const node = {
      dependencies: new Set(),
      directWorkspaceParents: new Set(),
      kind: "workspace",
      licenseExpression: null,
      name,
      native: false,
      notice: null,
      purl: ref,
      ref,
      root: workspace.root,
      version: packageVersion
    };
    nodeByRef.set(ref, node);
    rootToRef.set(workspace.root, ref);
    queue.push({ manifest: workspace.manifest, node });
  }

  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.node.ref)) continue;
    visited.add(current.node.ref);
    const dependencies = declaredRuntimeDependencies(current.manifest);
    for (const dependency of dependencies) {
      const workspace = workspaceByName.get(dependency.name);
      if (workspace !== undefined) {
        if (dependency.specifier !== "workspace:*") {
          throw new TypeError("Workspace runtime dependency is not declared through workspace:*.");
        }
        const childRef = rootToRef.get(workspace.root);
        if (childRef === undefined) throw new TypeError("Workspace dependency graph is incomplete.");
        current.node.dependencies.add(childRef);
        continue;
      }

      const dependencyRoot = resolveInstalledPackageRoot(
        root,
        current.node.root,
        dependency.name,
        dependency.optional
      );
      if (dependencyRoot === null) continue;
      const manifest = readPackageManifest(dependencyRoot, "Installed package");
      if (manifest.name !== dependency.name) {
        throw new TypeError("Installed dependency name does not match its declaration.");
      }
      if (!packageSupportsTarget(manifest, platform)) {
        if (dependency.optional) continue;
        throw new TypeError("Required installed dependency does not support the selected target.");
      }
      const version = parsePackageVersion(manifest.version, "Installed dependency version");
      const ref = npmPurl(dependency.name, version);
      let child = nodeByRef.get(ref);
      if (child === undefined) {
        const licenseExpression = parseApprovedLicense(manifest.license, dependency.name);
        child = {
          dependencies: new Set(),
          directWorkspaceParents: new Set(),
          kind: "npm",
          licenseExpression,
          name: dependency.name,
          native: false,
          notice: null,
          purl: ref,
          ref,
          root: dependencyRoot,
          version
        };
        nodeByRef.set(ref, child);
        rootToRef.set(dependencyRoot, ref);
        queue.push({ manifest, node: child });
      } else if (child.root !== dependencyRoot) {
        const otherManifest = readPackageManifest(child.root, "Installed package");
        if (
          otherManifest.name !== manifest.name ||
          otherManifest.version !== manifest.version ||
          otherManifest.license !== manifest.license
        ) {
          throw new TypeError("Duplicate package identity resolves to inconsistent manifests.");
        }
      }
      current.node.dependencies.add(ref);
      if (current.node.kind === "workspace") {
        child.directWorkspaceParents.add(current.node.name);
      }
    }
    if (nodeByRef.size > limits.dependencyCount) {
      throw new TypeError("Production dependency graph exceeds its release bound.");
    }
  }

  const entryRefs = productEntryPackages.map((name) => npmPurl(name, packageVersion));
  const nodes = [...nodeByRef.values()]
    .map((node) =>
      Object.freeze({
        dependencies: [...node.dependencies].sort(compareText),
        directWorkspaceParents: [...node.directWorkspaceParents].sort(compareText),
        kind: node.kind,
        licenseExpression: node.licenseExpression,
        name: node.name,
        native: node.native,
        notice: node.notice,
        purl: node.purl,
        ref: node.ref,
        version: node.version
      })
    )
    .sort((left, right) => compareText(left.ref, right.ref));
  validateDependencyGraph({ entryRefs, nodes });
  return deepFreeze({ entryRefs, nodes });
}

export function createSupplyChainDocuments(input) {
  const snapshot = validateSnapshot(input);
  const checksumText = serializeChecksumRecords(snapshot.packageFiles.files);
  const licenses = createLicenseInventory(snapshot);
  const licenseText = serializeJson(licenses);
  const sbomText = createCycloneDxSbom(snapshot);
  const provenance = createSlsaProvenance(snapshot, {
    checksums: checksumText,
    licenses: licenseText,
    sbom: sbomText
  });
  const provenanceText = serializeJson(provenance);
  const documents = new Map([
    ["SHA256SUMS", checksumText],
    ["licenses.json", licenseText],
    ["hostdeck.cdx.json", sbomText],
    ["hostdeck.provenance.json", provenanceText]
  ]);
  const index = createMetadataIndex(snapshot, documents);
  documents.set("metadata.json", serializeJson(index));
  for (const [name, text] of documents) {
    assertDocumentBytes(name, text);
    scanReleaseMetadataPrivacy(text);
  }
  return deepFreeze(Object.fromEntries([...documents].sort(([left], [right]) => compareText(left, right))));
}

export function verifySupplyChainDocumentSet(input, candidate) {
  const expected = createSupplyChainDocuments(input);
  const value = exactRecord(candidate, metadataFileNames, "Supply-chain document set");
  for (const name of metadataFileNames) {
    if (typeof value[name] !== "string" || value[name] !== expected[name]) {
      throw new TypeError(`Supply-chain document is missing, non-canonical, or inconsistent: ${name}`);
    }
  }
  return metadataSummary(expected);
}

export function generateSupplyChainMetadata(options) {
  const paths = resolveReleasePaths(options);
  if (existsSync(paths.outputRoot)) {
    throw new TypeError("Supply-chain metadata output already exists.");
  }
  const snapshot = loadSupplyChainSnapshot(paths);
  const documents = createSupplyChainDocuments(snapshot);
  const stagingRoot = mkdtempSync(join(paths.outputParent, ".hostdeck-metadata-"));
  try {
    for (const name of metadataFileNames) {
      writeFileSync(join(stagingRoot, name), documents[name], {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644
      });
      chmodSync(join(stagingRoot, name), 0o644);
    }
    verifySupplyChainMetadata({
      ...paths,
      outputRoot: stagingRoot
    });
    renameSync(stagingRoot, paths.outputRoot);
  } catch (error) {
    rmSync(stagingRoot, { force: true, recursive: true });
    throw error;
  }
  return metadataSummary(documents);
}

export function verifySupplyChainMetadata(options) {
  const paths = resolveReleasePaths(options, true);
  const outputRoot = realpathSync(paths.outputRoot);
  const entries = readdirSync(outputRoot, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name)
  );
  if (
    entries.length !== metadataFileNames.length ||
    entries.some(
      (entry, index) =>
        entry.name !== metadataFileNames[index] ||
        !entry.isFile() ||
        entry.isSymbolicLink()
    )
  ) {
    throw new TypeError("Supply-chain metadata directory contents are invalid.");
  }
  const candidate = {};
  for (const name of metadataFileNames) {
    const path = join(outputRoot, name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size < 1 || stats.size > limits.documentBytes) {
      throw new TypeError(`Supply-chain metadata file identity is invalid: ${name}`);
    }
    const bytes = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertDocumentBytes(name, text);
    scanReleaseMetadataPrivacy(text);
    candidate[name] = text;
  }
  const snapshot = loadSupplyChainSnapshot(paths);
  const result = verifySupplyChainDocumentSet(snapshot, candidate);
  const finalVerification = verifyProductionPackage(paths.packageRoot);
  if (
    finalVerification.contentSha256 !== snapshot.verification.contentSha256 ||
    finalVerification.entryCount !== snapshot.verification.entryCount
  ) {
    throw new TypeError("Package changed while supply-chain metadata was verified.");
  }
  return result;
}

export function serializeChecksumRecords(records) {
  const files = exactArray(records, 1, limits.packageFileCount, "Package checksum records");
  let previous = "";
  const lines = [];
  for (const [index, candidate] of files.entries()) {
    const value = exactRecord(candidate, ["path", "sha256", "size"], `Package file ${index}`);
    const path = assertMetadataPath(value.path, `Package file ${index}`);
    parseSha256(value.sha256, `Package file ${index} SHA-256`);
    exactInteger(value.size, 0, limits.packageBytes, `Package file ${index} size`);
    if (index > 0 && compareText(previous, path) >= 0) {
      throw new TypeError("Package checksum records are duplicated or not sorted.");
    }
    previous = path;
    lines.push(`${value.sha256}  ${path}`);
  }
  return `${lines.join("\n")}\n`;
}

export function scanReleaseMetadataPrivacy(text) {
  if (typeof text !== "string" || text.length < 1) {
    throw new TypeError("Release metadata text is invalid.");
  }
  if (privatePathPattern.test(text) || privateIdentityPattern.test(text)) {
    throw new TypeError("Release metadata contains private host or identity material.");
  }
  for (const match of text.matchAll(/https?:\/\/[^"\s]+/gu)) {
    const value = match[0];
    if (!knownPublicUrls.has(value)) {
      throw new TypeError("Release metadata contains an unapproved URL.");
    }
  }
}

function loadSupplyChainSnapshot(paths) {
  const verification = verifyProductionPackage(paths.packageRoot);
  const manifestPath = join(paths.packageRoot, productionPackageManifestName);
  const manifestBytes = readBoundedRegularFile(
    manifestPath,
    limits.packageManifestBytes,
    "Package manifest"
  );
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (cause) {
    throw new TypeError("Package manifest cannot be read for release metadata.", { cause });
  }
  validateNativePackageIdentityContract({
    artifact: manifest.artifact,
    runtime: manifest.runtime,
    source: manifest.source,
    target: manifest.target
  });
  const evidence = verifyNativeCiEvidenceFile(paths.nativeEvidencePath);
  const evidenceBytes = readBoundedRegularFile(
    paths.nativeEvidencePath,
    64 * 1024,
    "Native CI evidence"
  );
  const lockfileBytes = readBoundedRegularFile(
    join(paths.repositoryRoot, "pnpm-lock.yaml"),
    16 * 1024 * 1024,
    "pnpm lockfile"
  );
  const lockfileSha256 = sha256Hex(lockfileBytes);
  assertPackageEvidenceAgreement(manifest, evidence, lockfileSha256);
  let graph = collectProductionDependencyGraph(
    paths.repositoryRoot,
    manifest.packageVersion,
    manifest.target
  );
  const packageFiles = collectPackageFileRecords(paths.packageRoot);
  graph = bindNativeAndRuntimeComponents(graph, manifest, paths.packageRoot);
  const snapshot = {
    evidence,
    evidenceSha256: sha256Hex(evidenceBytes),
    graph,
    lockfileSha256,
    manifest,
    manifestFileSha256: sha256Hex(manifestBytes),
    packageFiles,
    verification
  };
  validateSnapshot(snapshot);
  return deepFreeze(snapshot);
}

function bindNativeAndRuntimeComponents(graph, manifest, packageRoot) {
  const nativeIdentities = new Map(
    manifest.nativeModules.map((entry) => [`${entry.package}@${entry.version}`, entry])
  );
  const nodes = graph.nodes.map((node) => ({ ...node }));
  for (const node of nodes) {
    if (nativeIdentities.has(`${node.name}@${node.version}`)) node.native = true;
  }
  for (const key of nativeIdentities.keys()) {
    if (!nodes.some((node) => `${node.name}@${node.version}` === key)) {
      throw new TypeError("Native package is missing from the production dependency graph.");
    }
  }
  const entryRefs = [...graph.entryRefs];
  if (manifest.runtime.delivery === "bundled") {
    const licensePath = join(packageRoot, "runtime", "LICENSE");
    const notice = readBoundedRegularFile(licensePath, 4 * 1024 * 1024, "Bundled Node license");
    const purl = genericPurl("node", manifest.runtime.node, {
      arch: manifest.target.architecture,
      os: manifest.target.platform
    });
    nodes.push({
      dependencies: [],
      directWorkspaceParents: [],
      kind: "runtime",
      licenseExpression: "MIT",
      name: "node",
      native: true,
      notice: {
        path: "runtime/LICENSE",
        sha256: sha256Hex(notice)
      },
      purl,
      ref: purl,
      version: manifest.runtime.node
    });
    entryRefs.push(purl);
  }
  nodes.sort((left, right) => compareText(left.ref, right.ref));
  entryRefs.sort(compareText);
  validateDependencyGraph({ entryRefs, nodes });
  return deepFreeze({ entryRefs, nodes });
}

function createLicenseInventory(snapshot) {
  const packages = snapshot.graph.nodes
    .filter((node) => node.kind === "npm" || node.kind === "runtime")
    .map((node) => ({
      directWorkspaceParents: node.directWorkspaceParents,
      kind: node.kind,
      licenseExpression: node.licenseExpression,
      name: node.name,
      native: node.native,
      ...(node.notice === null ? {} : { notice: node.notice }),
      purl: node.purl,
      version: node.version
    }));
  const unsigned = {
    schemaVersion: supplyChainMetadataSchemaVersion,
    name: "hostdeck-third-party-license-inventory",
    packageVersion: snapshot.manifest.packageVersion,
    target: snapshot.manifest.target.id,
    source: {
      commit: snapshot.manifest.source.commit,
      lockfileSha256: snapshot.lockfileSha256
    },
    approvedExpressions: approvedLicenseExpressions,
    packages
  };
  return deepFreeze({
    ...unsigned,
    inventorySha256: sha256Hex(stableJson(unsigned))
  });
}

function createCycloneDxSbom(snapshot) {
  const bom = new Bom();
  const rootRef = packageTreeRef(snapshot.manifest);
  const root = new Component(ComponentType.Application, "HostDeck", {
    bomRef: rootRef,
    version: snapshot.manifest.packageVersion
  });
  root.hashes.set(HashAlgorithm["SHA-256"], snapshot.manifest.content.sha256);
  root.properties.add(new Property("hostdeck:release:artifact-kind", snapshot.manifest.artifact.kind));
  root.properties.add(new Property("hostdeck:release:runtime-delivery", snapshot.manifest.runtime.delivery));
  root.properties.add(new Property("hostdeck:release:target", snapshot.manifest.target.id));
  bom.metadata.component = root;

  const componentByRef = new Map();
  for (const node of snapshot.graph.nodes) {
    const { group, name } = splitPackageName(node.name);
    const component = new Component(
      node.kind === "runtime" ? ComponentType.Framework : ComponentType.Library,
      name,
      {
        bomRef: node.ref,
        ...(group === undefined ? {} : { group }),
        purl: node.purl,
        scope: ComponentScope.Required,
        version: node.version
      }
    );
    if (node.licenseExpression !== null) {
      component.licenses.add(new LicenseExpression(node.licenseExpression));
    }
    component.properties.add(new Property("hostdeck:release:component-kind", node.kind));
    if (node.native) {
      component.properties.add(new Property("hostdeck:release:native", "true"));
    }
    if (node.kind === "runtime" && snapshot.manifest.runtime.bundle !== null) {
      component.hashes.set(HashAlgorithm["SHA-256"], snapshot.manifest.runtime.bundle.sha256);
    }
    componentByRef.set(node.ref, component);
    bom.components.add(component);
  }
  for (const node of snapshot.graph.nodes) {
    const component = componentByRef.get(node.ref);
    if (component === undefined) throw new TypeError("SBOM component graph is incomplete.");
    for (const dependencyRef of node.dependencies) {
      const dependency = componentByRef.get(dependencyRef);
      if (dependency === undefined) throw new TypeError("SBOM dependency graph is incomplete.");
      component.dependencies.add(dependency.bomRef);
    }
  }
  for (const entryRef of snapshot.graph.entryRefs) {
    const component = componentByRef.get(entryRef);
    if (component === undefined) throw new TypeError("SBOM product entry is missing.");
    root.dependencies.add(component.bomRef);
  }
  const serializer = new JsonSerializer(new CycloneDxJson.Normalize.Factory(Spec1dot7));
  const text = `${serializer.serialize(bom, { sortLists: true, space: 2 })}\n`;
  validateCycloneDxShape(JSON.parse(text), snapshot);
  return text;
}

function createSlsaProvenance(snapshot, byproducts) {
  const subjects = [
    {
      name: `hostdeck-package/${snapshot.manifest.target.id}/tree`,
      digest: { sha256: snapshot.manifest.content.sha256 }
    },
    ...snapshot.packageFiles.files.map((file) => ({
      name: `hostdeck-package/${file.path}`,
      digest: { sha256: file.sha256 }
    }))
  ];
  return deepFreeze({
    _type: "https://in-toto.io/Statement/v1",
    subject: subjects,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "urn:hostdeck:build:native-package:v1",
        externalParameters: {
          artifactKind: snapshot.manifest.artifact.kind,
          packageVersion: snapshot.manifest.packageVersion,
          target: snapshot.manifest.target.id
        },
        internalParameters: {
          node: snapshot.manifest.runtime.node,
          nodeAbi: snapshot.manifest.runtime.nodeAbi,
          pnpm: snapshot.manifest.runtime.pnpm
        },
        resolvedDependencies: [
          {
            uri: "urn:hostdeck:source",
            digest: { gitCommit: snapshot.manifest.source.commit }
          },
          {
            uri: "urn:hostdeck:source:pnpm-lock",
            digest: { sha256: snapshot.lockfileSha256 }
          },
          {
            uri: "urn:hostdeck:package-manifest",
            digest: { sha256: snapshot.manifestFileSha256 }
          },
          {
            uri: "urn:hostdeck:native-ci-evidence",
            digest: { sha256: snapshot.evidenceSha256 }
          }
        ]
      },
      runDetails: {
        builder: { id: "urn:hostdeck:builder:native-ci:v1" },
        metadata: {
          invocationId: `urn:hostdeck:native-ci:${snapshot.evidence.target}:${snapshot.evidence.workflow.run_id}:${snapshot.evidence.workflow.run_attempt}`
        },
        byproducts: [
          resourceDescriptor("SHA256SUMS", byproducts.checksums),
          resourceDescriptor("licenses.json", byproducts.licenses),
          resourceDescriptor("hostdeck.cdx.json", byproducts.sbom)
        ]
      }
    }
  });
}

function createMetadataIndex(snapshot, documents) {
  const descriptors = documentDescriptors.map(({ kind, path }) => {
    const text = documents.get(path);
    if (text === undefined) throw new TypeError("Supply-chain document index is incomplete.");
    return {
      kind,
      path,
      sha256: sha256Hex(text),
      size: Buffer.byteLength(text, "utf8")
    };
  });
  const unsigned = {
    schemaVersion: supplyChainMetadataSchemaVersion,
    name: "hostdeck-supply-chain-metadata",
    package: {
      artifactKind: snapshot.manifest.artifact.kind,
      contentSha256: snapshot.manifest.content.sha256,
      fileBytes: snapshot.packageFiles.bytes,
      fileCount: snapshot.packageFiles.files.length,
      manifestFileSha256: snapshot.manifestFileSha256,
      manifestSha256: snapshot.manifest.manifestSha256,
      target: snapshot.manifest.target.id,
      version: snapshot.manifest.packageVersion
    },
    source: {
      commit: snapshot.manifest.source.commit,
      lockfileSha256: snapshot.lockfileSha256
    },
    nativeCi: {
      evidenceSha256: snapshot.evidenceSha256,
      runAttempt: snapshot.evidence.workflow.run_attempt,
      runId: snapshot.evidence.workflow.run_id,
      target: snapshot.evidence.target
    },
    documents: descriptors
  };
  return deepFreeze({
    ...unsigned,
    metadataSha256: sha256Hex(stableJson(unsigned))
  });
}

function validateSnapshot(candidate) {
  const value = exactRecord(
    candidate,
    [
      "evidence",
      "evidenceSha256",
      "graph",
      "lockfileSha256",
      "manifest",
      "manifestFileSha256",
      "packageFiles",
      "verification"
    ],
    "Supply-chain snapshot"
  );
  parseSha256(value.evidenceSha256, "Evidence SHA-256");
  parseSha256(value.lockfileSha256, "Lockfile SHA-256");
  parseSha256(value.manifestFileSha256, "Manifest-file SHA-256");
  const manifest = value.manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Package manifest snapshot is invalid.");
  }
  validateNativePackageIdentityContract({
    artifact: manifest.artifact,
    runtime: manifest.runtime,
    source: manifest.source,
    target: manifest.target
  });
  parseExactVersion(manifest.packageVersion, "Package version");
  parseSha256(manifest.manifestSha256, "Package manifest identity");
  parseSha256(manifest.content?.sha256, "Package content identity");
  exactInteger(manifest.content?.entryCount, 1, limits.packageFileCount * 3, "Package entry count");
  exactInteger(manifest.content?.bytes, 1, limits.packageBytes, "Package content bytes");
  if (!Array.isArray(manifest.nativeModules) || manifest.nativeModules.length !== 3) {
    throw new TypeError("Package native-module snapshot is invalid.");
  }
  assertPackageEvidenceAgreement(manifest, value.evidence, value.lockfileSha256);
  validateDependencyGraph(value.graph);
  assertReleaseGraphManifestAgreement(value.graph, manifest);
  const packageFiles = value.packageFiles;
  if (
    packageFiles === null ||
    typeof packageFiles !== "object" ||
    Array.isArray(packageFiles) ||
    !Array.isArray(packageFiles.files)
  ) {
    throw new TypeError("Package file snapshot is invalid.");
  }
  serializeChecksumRecords(packageFiles.files);
  const fileBytes = packageFiles.files.reduce((total, file) => total + file.size, 0);
  if (packageFiles.bytes !== fileBytes) throw new TypeError("Package file byte count is inconsistent.");
  const verification = exactRecord(
    value.verification,
    [
      "contentSha256",
      "entryCount",
      "outputCount",
      "packageVersion",
      "sourceCount",
      "webBytes",
      "webFileCount",
      "webSha256"
    ],
    "Package verification snapshot"
  );
  if (
    verification.contentSha256 !== manifest.content.sha256 ||
    verification.entryCount !== manifest.content.entryCount ||
    verification.packageVersion !== manifest.packageVersion
  ) {
    throw new TypeError("Package verification snapshot is inconsistent.");
  }
  return value;
}

function assertReleaseGraphManifestAgreement(graph, manifest) {
  const workspaceNames = graph.nodes
    .filter((node) => node.kind === "workspace")
    .map(({ name }) => name)
    .sort(compareText);
  const expectedWorkspaceNames = workspaceDirectories
    .map((directory) => `@hostdeck/${basename(directory)}`)
    .sort(compareText);
  if (stableJson(workspaceNames) !== stableJson(expectedWorkspaceNames)) {
    throw new TypeError("Release dependency graph workspace closure is incomplete.");
  }
  for (const descriptor of manifest.nativeModules) {
    const matches = graph.nodes.filter(
      (node) =>
        node.kind === "npm" &&
        node.name === descriptor.package &&
        node.version === descriptor.version &&
        node.native === true
    );
    if (matches.length !== 1) {
      throw new TypeError("Release dependency graph native-module closure is incomplete.");
    }
  }
  const runtimeNodes = graph.nodes.filter((node) => node.kind === "runtime");
  if (manifest.runtime.delivery === "host_provided") {
    if (runtimeNodes.length !== 0) {
      throw new TypeError("Host-provided runtime must not be an SBOM component.");
    }
    return;
  }
  if (
    runtimeNodes.length !== 1 ||
    runtimeNodes[0].name !== "node" ||
    runtimeNodes[0].version !== manifest.runtime.node ||
    runtimeNodes[0].licenseExpression !== "MIT" ||
    runtimeNodes[0].native !== true ||
    runtimeNodes[0].notice === null
  ) {
    throw new TypeError("Bundled runtime SBOM and license identity is incomplete.");
  }
}

function validateDependencyGraph(candidate) {
  const value = exactRecord(candidate, ["entryRefs", "nodes"], "Production dependency graph");
  const entryRefs = exactArray(value.entryRefs, 1, 8, "Product entry references");
  const nodes = exactArray(value.nodes, 1, limits.dependencyCount, "Production dependency nodes");
  const refs = new Set();
  let previous = "";
  for (const [index, node] of nodes.entries()) {
    const value = exactRecord(
      node,
      [
        "dependencies",
        "directWorkspaceParents",
        "kind",
        "licenseExpression",
        "name",
        "native",
        "notice",
        "purl",
        "ref",
        "version"
      ],
      `Dependency node ${index}`
    );
    if (!["npm", "runtime", "workspace"].includes(value.kind)) {
      throw new TypeError("Dependency component kind is invalid.");
    }
    parsePackageName(value.name, "Dependency package name");
    parsePackageVersion(value.version, "Dependency package version");
    if (value.ref !== value.purl || typeof value.ref !== "string" || !value.ref.startsWith("pkg:")) {
      throw new TypeError("Dependency package URL is invalid.");
    }
    if (index > 0 && compareText(previous, value.ref) >= 0) {
      throw new TypeError("Dependency nodes are duplicated or not sorted.");
    }
    previous = value.ref;
    refs.add(value.ref);
    exactBoolean(value.native, "Dependency native marker");
    if (value.kind === "workspace") {
      if (value.licenseExpression !== null || value.notice !== null) {
        throw new TypeError("First-party workspace license metadata is invalid.");
      }
    } else {
      parseApprovedLicense(value.licenseExpression, value.name);
    }
    if (value.notice !== null) {
      const notice = exactRecord(value.notice, ["path", "sha256"], "Runtime license notice");
      assertMetadataPath(notice.path, "Runtime license notice path");
      parseSha256(notice.sha256, "Runtime license notice SHA-256");
    }
    assertSortedUniqueStrings(value.dependencies, 0, limits.dependencyCount, "Dependency references");
    assertSortedUniqueStrings(
      value.directWorkspaceParents,
      0,
      workspaceDirectories.length,
      "Direct workspace parents"
    );
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!refs.has(dependency)) throw new TypeError("Dependency graph contains a missing component.");
    }
  }
  assertSortedUniqueStrings(entryRefs, 1, 8, "Product entry references");
  for (const entryRef of entryRefs) {
    if (!refs.has(entryRef)) throw new TypeError("Product entry component is missing.");
  }
  return value;
}

function validateCycloneDxShape(candidate, snapshot) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.$schema !== "http://cyclonedx.org/schema/bom-1.7.schema.json" ||
    candidate.bomFormat !== "CycloneDX" ||
    candidate.specVersion !== "1.7" ||
    candidate.version !== 1 ||
    candidate.metadata?.component?.["bom-ref"] !== packageTreeRef(snapshot.manifest) ||
    !Array.isArray(candidate.components) ||
    candidate.components.length !== snapshot.graph.nodes.length ||
    !Array.isArray(candidate.dependencies) ||
    candidate.dependencies.length !== snapshot.graph.nodes.length + 1
  ) {
    throw new TypeError("CycloneDX 1.7 document shape is invalid.");
  }
  const componentRefs = candidate.components.map((component) => component["bom-ref"]);
  assertUnique(componentRefs, "CycloneDX component reference");
  const expectedRefs = snapshot.graph.nodes.map(({ ref }) => ref).sort(compareText);
  if (stableJson([...componentRefs].sort(compareText)) !== stableJson(expectedRefs)) {
    throw new TypeError("CycloneDX component closure is inconsistent.");
  }
  const dependencyRefs = candidate.dependencies.map(({ ref }) => ref);
  assertUnique(dependencyRefs, "CycloneDX dependency reference");
}

function assertPackageEvidenceAgreement(manifest, evidence, lockfileSha256) {
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    evidence.target !== manifest.target.id ||
    evidence.source?.commit !== manifest.source.commit ||
    evidence.source?.lockfile_sha256 !== lockfileSha256 ||
    evidence.toolchain?.node_version !== manifest.runtime.node ||
    evidence.toolchain?.node_module_abi !== manifest.runtime.nodeAbi ||
    evidence.toolchain?.pnpm_version !== manifest.runtime.pnpm
  ) {
    throw new TypeError("Package, lockfile, and native-CI identities do not agree.");
  }
  const packageNative = manifest.nativeModules.map(({ package: name, version }) => ({ name, version }));
  if (stableJson(packageNative) !== stableJson(evidence.native_dependencies)) {
    throw new TypeError("Package and native-CI dependency identities do not agree.");
  }
}

function declaredRuntimeDependencies(manifest) {
  const result = new Map();
  addDependencyGroup(result, manifest.dependencies, false, "dependencies");
  addDependencyGroup(result, manifest.optionalDependencies, true, "optionalDependencies");
  if (manifest.peerDependencies !== undefined) {
    if (
      manifest.peerDependencies === null ||
      typeof manifest.peerDependencies !== "object" ||
      Array.isArray(manifest.peerDependencies)
    ) {
      throw new TypeError("Package peerDependencies metadata is invalid.");
    }
    for (const [name, specifier] of Object.entries(manifest.peerDependencies)) {
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
      addDeclaredDependency(result, name, specifier, optional, "peerDependencies");
    }
  }
  return [...result.values()].sort((left, right) => compareText(left.name, right.name));
}

function addDependencyGroup(result, candidate, optional, label) {
  if (candidate === undefined) return;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Package ${label} metadata is invalid.`);
  }
  for (const [name, specifier] of Object.entries(candidate)) {
    addDeclaredDependency(result, name, specifier, optional, label);
  }
}

function addDeclaredDependency(result, name, specifier, optional, label) {
  parsePackageName(name, `Package ${label} name`);
  if (typeof specifier !== "string" || specifier.length < 1 || specifier.length > 256) {
    throw new TypeError(`Package ${label} specifier is invalid.`);
  }
  const existing = result.get(name);
  result.set(name, {
    name,
    optional: existing === undefined ? optional : existing.optional && optional,
    specifier
  });
}

function resolveInstalledPackageRoot(repositoryRoot, fromRoot, name, optional) {
  let current = fromRoot;
  while (isInside(repositoryRoot, current)) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(candidate)) {
      const resolved = realpathSync(candidate);
      if (!isInside(join(repositoryRoot, "node_modules"), resolved)) {
        throw new TypeError("Installed dependency resolves outside repository node_modules.");
      }
      return resolved;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (optional) return null;
  throw new TypeError(`Required production dependency is not installed: ${name}`);
}

function readPackageManifest(packageRoot, label) {
  const bytes = readBoundedRegularFile(
    join(packageRoot, "package.json"),
    1024 * 1024,
    `${label} manifest`,
    false
  );
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new TypeError(`${label} manifest is invalid JSON.`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} manifest must be an object.`);
  }
  return value;
}

function readBoundedRegularFile(path, maximumBytes, label, requireSingleLink = true) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    throw new TypeError(`${label} is missing.`, { cause });
  }
  if (
    !stats.isFile() ||
    (requireSingleLink && stats.nlink !== 1) ||
    stats.size < 1 ||
    stats.size > maximumBytes
  ) {
    throw new TypeError(`${label} is not one bounded regular file.`);
  }
  return readFileSync(path);
}

function packageSupportsTarget(manifest, target) {
  return matchesPlatformConstraint(manifest.os, target.platform) && matchesPlatformConstraint(manifest.cpu, target.architecture);
}

function matchesPlatformConstraint(candidate, actual) {
  if (candidate === undefined) return true;
  const values = typeof candidate === "string" ? [candidate] : candidate;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length < 1)) {
    throw new TypeError("Package platform constraint is invalid.");
  }
  if (values.includes(`!${actual}`)) return false;
  const positives = values.filter((value) => !value.startsWith("!"));
  return positives.length === 0 || positives.includes(actual);
}

function parseTargetPlatform(candidate) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !["linux", "win32"].includes(candidate.platform) ||
    candidate.architecture !== "x64"
  ) {
    throw new TypeError("Dependency target platform is invalid.");
  }
  return { architecture: candidate.architecture, platform: candidate.platform };
}

function parseApprovedLicense(candidate, packageName) {
  if (typeof candidate !== "string" || !approvedLicenseSet.has(candidate)) {
    throw new TypeError(`Production dependency has an unapproved license expression: ${packageName}`);
  }
  return candidate;
}

function resolveReleasePaths(options, outputMustExist = false) {
  const value = exactRecord(
    options,
    ["nativeEvidencePath", "outputRoot", "packageRoot", "repositoryRoot"],
    "Release metadata paths"
  );
  const repositoryRoot = realpathSync(resolve(value.repositoryRoot));
  const packageRoot = realpathSync(resolve(value.packageRoot));
  const nativeEvidencePath = realpathSync(resolve(value.nativeEvidencePath));
  const requestedOutput = resolve(value.outputRoot);
  const outputParentRequested = dirname(requestedOutput);
  mkdirSync(outputParentRequested, { mode: 0o755, recursive: true });
  const outputParent = realpathSync(outputParentRequested);
  const outputRoot = join(outputParent, basename(requestedOutput));
  if (outputRoot !== requestedOutput || basename(outputRoot).startsWith(".")) {
    throw new TypeError("Supply-chain metadata output path is invalid.");
  }
  if (outputMustExist && !existsSync(outputRoot)) {
    throw new TypeError("Supply-chain metadata output is missing.");
  }
  return Object.freeze({
    nativeEvidencePath,
    outputParent,
    outputRoot,
    packageRoot,
    repositoryRoot
  });
}

function resourceDescriptor(name, text) {
  return {
    name,
    digest: { sha256: sha256Hex(text) }
  };
}

function packageTreeRef(manifest) {
  return `urn:hostdeck:package:${manifest.target.id}:${manifest.packageVersion}:${manifest.content.sha256}`;
}

function npmPurl(name, version) {
  parsePackageName(name, "Package URL name");
  parsePackageVersion(version, "Package URL version");
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/%40${encodeURIComponent(scope.slice(1))}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function genericPurl(name, version, qualifiers) {
  const query = Object.entries(qualifiers)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}?${query}`;
}

function splitPackageName(name) {
  if (!name.startsWith("@")) return { name };
  const [group, packageName] = name.split("/");
  return { group, name: packageName };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function metadataSummary(documents) {
  const index = JSON.parse(documents["metadata.json"]);
  return Object.freeze({
    documentCount: index.documents.length + 1,
    fileCount: index.package.fileCount,
    metadataSha256: index.metadataSha256,
    packageContentSha256: index.package.contentSha256,
    target: index.package.target
  });
}

function assertDocumentBytes(name, text) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (
    bytes < 1 ||
    bytes > limits.documentBytes ||
    !text.endsWith("\n") ||
    text.includes("\r") ||
    text.includes("\0")
  ) {
    throw new TypeError(`Supply-chain document encoding or size is invalid: ${name}`);
  }
}

function verifyContainedSymlink(root, path, portablePath) {
  const target = readlinkSync(path);
  if (isAbsolute(target) || target.includes("\0") || /[\r\n]/u.test(target)) {
    throw new TypeError(`Package symlink target is unsafe: ${portablePath}`);
  }
  let resolved;
  try {
    resolved = realpathSync(resolve(dirname(path), target));
  } catch (cause) {
    throw new TypeError(`Package symlink is broken: ${portablePath}`, { cause });
  }
  if (!isInside(root, resolved)) {
    throw new TypeError(`Package symlink escapes its package: ${portablePath}`);
  }
}

function assertMetadataPath(candidate, label) {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    Buffer.byteLength(candidate, "utf8") > 4096 ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new TypeError(`${label} path is invalid.`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${label} path contains an unsafe segment.`);
  }
  return candidate;
}

function toPortablePath(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function isInside(root, target) {
  const candidate = relative(root, target);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function parsePackageName(candidate, label) {
  if (typeof candidate !== "string" || !packageNamePattern.test(candidate)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
}

function parsePackageVersion(candidate, label) {
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > 128 ||
    /[\s/\\?#]/u.test(candidate)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
}

function parseExactVersion(candidate, label) {
  if (typeof candidate !== "string" || !exactVersionPattern.test(candidate)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
}

function parseSha256(candidate, label) {
  if (typeof candidate !== "string" || !sha256Pattern.test(candidate)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
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

function exactArray(candidate, minimum, maximum, label) {
  if (!Array.isArray(candidate) || candidate.length < minimum || candidate.length > maximum) {
    throw new TypeError(`${label} length is invalid.`);
  }
  return candidate;
}

function exactInteger(candidate, minimum, maximum, label) {
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return candidate;
}

function exactBoolean(candidate, label) {
  if (typeof candidate !== "boolean") throw new TypeError(`${label} is invalid.`);
  return candidate;
}

function assertSortedUniqueStrings(candidate, minimum, maximum, label) {
  const values = exactArray(candidate, minimum, maximum, label);
  let previous = "";
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length < 1 || (index > 0 && compareText(previous, value) >= 0)) {
      throw new TypeError(`${label} are invalid, duplicated, or unsorted.`);
    }
    previous = value;
  }
  return values;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) throw new TypeError(`${label} is duplicated or invalid.`);
    seen.add(value);
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function parseCliArguments(arguments_) {
  if (arguments_.length !== 9 || !["generate", "verify"].includes(arguments_[0])) {
    throw new TypeError(
      "Usage: supply-chain-metadata.mjs <generate|verify> --package <path> --evidence <path> --output <path> --repository <path>"
    );
  }
  const values = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--evidence", "--output", "--package", "--repository"].includes(flag) || values[flag] !== undefined) {
      throw new TypeError("Supply-chain metadata command flags are invalid.");
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== 4) throw new TypeError("Supply-chain metadata command flags are incomplete.");
  return {
    command: arguments_[0],
    options: {
      nativeEvidencePath: values["--evidence"],
      outputRoot: values["--output"],
      packageRoot: values["--package"],
      repositoryRoot: values["--repository"]
    }
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, options } = parseCliArguments(process.argv.slice(2));
    const result =
      command === "generate"
        ? generateSupplyChainMetadata(options)
        : verifySupplyChainMetadata(options);
    process.stdout.write(
      `HostDeck supply-chain metadata ${command === "generate" ? "generated" : "verified"}: ${result.target}, ${result.fileCount} package files, ${result.documentCount} records.\n`
    );
  } catch (error) {
    const message =
      error instanceof TypeError && !privatePathPattern.test(error.message)
        ? error.message
        : "Supply-chain metadata command failed before publication.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
