import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Version } from "@cyclonedx/cyclonedx-library/Spec";
import { JsonStrictValidator } from "@cyclonedx/cyclonedx-library/Validation";
import { buildProductionPackage } from "./build-production-package.mjs";
import {
  nativeCiTargetPolicies,
  writeNativeCiEvidence
} from "./native-ci-evidence.mjs";
import {
  collectPackageFileRecords,
  collectProductionDependencyGraph,
  createSupplyChainDocuments,
  generateSupplyChainMetadata,
  scanReleaseMetadataPrivacy,
  supplyChainApprovedLicenseExpressions,
  supplyChainMetadataFiles,
  verifySupplyChainDocumentSet,
  verifySupplyChainMetadata
} from "./supply-chain-metadata.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const workspaceNames = [
  "@hostdeck/core",
  "@hostdeck/contracts",
  "@hostdeck/codex-adapter",
  "@hostdeck/storage",
  "@hostdeck/server",
  "@hostdeck/cli",
  "@hostdeck/web"
];
const nativePackages = [
  ["better-sqlite3", "12.11.1"],
  ["fs-native-extensions", "1.3.4"],
  ["koffi", "3.1.4"]
];

test("creates canonical checksum, license, CycloneDX, provenance, and index records", async () => {
  const snapshot = fixtureSnapshot("linux-x64");
  const first = createSupplyChainDocuments(snapshot);
  const second = createSupplyChainDocuments(structuredClone(snapshot));
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), [...supplyChainMetadataFiles].sort());
  assert.equal(first.SHA256SUMS.split("\n").filter(Boolean).length, 2);

  const licenses = JSON.parse(first["licenses.json"]);
  assert.equal(licenses.schemaVersion, 1);
  assert.deepEqual(licenses.approvedExpressions, supplyChainApprovedLicenseExpressions);
  assert.equal(licenses.packages.length, 5);
  assert.equal(licenses.packages.filter(({ native }) => native).length, 4);

  const sbom = JSON.parse(first["hostdeck.cdx.json"]);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.7");
  assert.equal(sbom.components.length, snapshot.graph.nodes.length);
  assert.equal(sbom.dependencies.length, snapshot.graph.nodes.length + 1);
  assert.equal(await new JsonStrictValidator(Version.v1dot7).validate(first["hostdeck.cdx.json"]), null);

  const provenance = JSON.parse(first["hostdeck.provenance.json"]);
  assert.equal(provenance._type, "https://in-toto.io/Statement/v1");
  assert.equal(provenance.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(provenance.subject.length, snapshot.packageFiles.files.length + 1);
  assert.equal(provenance.predicate.buildDefinition.resolvedDependencies.length, 4);
  assert.equal(provenance.predicate.runDetails.byproducts.length, 3);

  const index = JSON.parse(first["metadata.json"]);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.documents.length, 4);
  assert.equal(index.package.fileCount, 2);
  assert.deepEqual(verifySupplyChainDocumentSet(snapshot, first), {
    documentCount: 5,
    fileCount: 2,
    metadataSha256: index.metadataSha256,
    packageContentSha256: snapshot.manifest.content.sha256,
    target: "linux-x64"
  });
});

test("fails closed for schema, graph, target, license, checksum, and privacy mutations", () => {
  const snapshot = fixtureSnapshot("linux-x64");
  const documents = createSupplyChainDocuments(snapshot);
  const snapshots = [
    mutate(snapshot, (value) => {
      value.lockfileSha256 = hash("other-lock");
    }),
    mutate(snapshot, (value) => {
      value.evidence.target = "windows-x64";
    }),
    mutate(snapshot, (value) => {
      value.graph.nodes = value.graph.nodes.filter(({ name }) => name !== "koffi");
    }),
    mutate(snapshot, (value) => {
      const node = value.graph.nodes.find(({ name }) => name === "zod");
      node.licenseExpression = "GPL-3.0-only";
    }),
    mutate(snapshot, (value) => {
      value.packageFiles.files.reverse();
    }),
    mutate(snapshot, (value) => {
      value.packageFiles.files.push({ ...value.packageFiles.files[0] });
    }),
    mutate(snapshot, (value) => {
      value.verification.contentSha256 = hash("wrong-content");
    })
  ];
  for (const candidate of snapshots) {
    assert.throws(() => createSupplyChainDocuments(candidate));
  }

  for (const name of supplyChainMetadataFiles) {
    const candidate = { ...documents, [name]: `${documents[name]} ` };
    assert.throws(() => verifySupplyChainDocumentSet(snapshot, candidate));
  }
  const missing = { ...documents };
  delete missing["licenses.json"];
  assert.throws(() => verifySupplyChainDocumentSet(snapshot, missing));
  assert.throws(() => scanReleaseMetadataPrivacy('{"path":"/home/private/build"}\n'));
  assert.throws(() => scanReleaseMetadataPrivacy('{"identity":"person@example.com"}\n'));
  assert.throws(() => scanReleaseMetadataPrivacy('{"host":"device.tail12345.ts.net"}\n'));
  assert.throws(() => scanReleaseMetadataPrivacy('{"url":"https://private.example/path"}\n'));
});

test("requires an explicit license notice for a bundled Windows runtime", () => {
  const snapshot = fixtureSnapshot("windows-x64");
  const documents = createSupplyChainDocuments(snapshot);
  const licenses = JSON.parse(documents["licenses.json"]);
  const runtime = licenses.packages.find(({ kind }) => kind === "runtime");
  assert.deepEqual(runtime, {
    directWorkspaceParents: [],
    kind: "runtime",
    licenseExpression: "MIT",
    name: "node",
    native: true,
    notice: {
      path: "runtime/LICENSE",
      sha256: hash("node-license")
    },
    purl: "pkg:generic/node@22.22.2?arch=x64&os=win32",
    version: "22.22.2"
  });
  const missingNotice = mutate(snapshot, (value) => {
    value.graph.nodes.find(({ kind }) => kind === "runtime").notice = null;
  });
  assert.throws(() => createSupplyChainDocuments(missingNotice), /runtime SBOM and license/u);
});

test("walks only the installed production graph for the current native target", () => {
  assert.equal(["linux", "win32"].includes(process.platform), true);
  const graph = collectProductionDependencyGraph(repositoryRoot, "0.0.0", {
    architecture: "x64",
    platform: process.platform
  });
  assert.equal(graph.nodes.filter(({ kind }) => kind === "workspace").length, 7);
  assert.equal(graph.nodes.filter(({ kind }) => kind === "npm").length, 181);
  assert.deepEqual(
    graph.nodes.filter(({ kind }) => kind === "workspace").map(({ name }) => name).sort(),
    [...workspaceNames].sort()
  );
  assert.equal(
    graph.nodes.some(({ name }) => name === `@koromix/koffi-${process.platform}-x64`),
    true
  );
  assert.deepEqual(
    [...new Set(graph.nodes.map(({ licenseExpression }) => licenseExpression).filter(Boolean))].sort(),
    [...supplyChainApprovedLicenseExpressions].sort()
  );
  assert.equal(JSON.stringify(graph).includes(repositoryRoot), false);
});

test("package checksum collection allows contained symlinks and rejects unsafe filesystem entries", () => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-package-files-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.txt"), "a", { mode: 0o644 });
    writeFileSync(join(root, "nested", "b.txt"), "bb", { mode: 0o644 });
    symlinkSync("nested", join(root, "contained"), "dir");
    assert.deepEqual(collectPackageFileRecords(root), {
      bytes: 3,
      files: [
        { path: "a.txt", sha256: hash("a"), size: 1 },
        { path: "nested/b.txt", sha256: hash("bb"), size: 2 }
      ]
    });

    symlinkSync("..", join(root, "escape"), "dir");
    assert.throws(() => collectPackageFileRecords(root), /escapes/u);
    rmSync(join(root, "escape"));

    linkSync(join(root, "a.txt"), join(root, "hard-link.txt"));
    assert.throws(() => collectPackageFileRecords(root), /regular non-linked/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

if (process.platform === "linux") {
  test(
    "generates and independently verifies deterministic metadata for a real package",
    { timeout: 240_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "hostdeck-supply-chain-integration-"));
      const packageRoot = join(repositoryRoot, "dist", `hostdeck-rel-v1-102-${process.pid}`);
      try {
        rmSync(packageRoot, { force: true, recursive: true });
        const build = buildProductionPackage({ outputRoot: packageRoot });
        const lockfileSha256 = hash(readFileSync(join(repositoryRoot, "pnpm-lock.yaml")));
        const evidencePath = join(root, "linux-x64.json");
        writeNativeCiEvidence(
          evidencePath,
          nativeEvidenceFixture("linux-x64", build.sourceCommit, lockfileSha256)
        );
        const options = {
          nativeEvidencePath: evidencePath,
          outputRoot: join(root, "metadata-a"),
          packageRoot,
          repositoryRoot
        };
        const generated = generateSupplyChainMetadata(options);
        assert.deepEqual(verifySupplyChainMetadata(options), generated);

        const secondOptions = { ...options, outputRoot: join(root, "metadata-b") };
        assert.deepEqual(generateSupplyChainMetadata(secondOptions), generated);
        for (const name of supplyChainMetadataFiles) {
          assert.deepEqual(
            readFileSync(join(options.outputRoot, name)),
            readFileSync(join(secondOptions.outputRoot, name))
          );
        }

        for (const name of supplyChainMetadataFiles) {
          const path = join(options.outputRoot, name);
          const original = readFileSync(path);
          writeFileSync(path, Buffer.concat([original, Buffer.from(" ")]));
          assert.throws(() => verifySupplyChainMetadata(options));
          writeFileSync(path, original);
        }

        const missingPath = join(options.outputRoot, "licenses.json");
        const missingBytes = readFileSync(missingPath);
        rmSync(missingPath);
        assert.throws(() => verifySupplyChainMetadata(options), /contents are invalid/u);
        writeFileSync(missingPath, missingBytes, { mode: 0o644 });

        writeFileSync(join(options.outputRoot, "extra.txt"), "extra", { mode: 0o644 });
        assert.throws(() => verifySupplyChainMetadata(options), /contents are invalid/u);
        rmSync(join(options.outputRoot, "extra.txt"));

        const packageFile = join(packageRoot, "verify.mjs");
        const packageBytes = readFileSync(packageFile);
        writeFileSync(packageFile, Buffer.concat([packageBytes, Buffer.from("\n")]), {
          mode: 0o644
        });
        assert.throws(() => verifySupplyChainMetadata(options));
        writeFileSync(packageFile, packageBytes, { mode: 0o644 });

        const evidenceSidecar = `${evidencePath}.sha256`;
        const sidecarBytes = readFileSync(evidenceSidecar);
        writeFileSync(evidenceSidecar, `${"0".repeat(64)}  linux-x64.json\n`);
        assert.throws(() => verifySupplyChainMetadata(options), /digest is invalid/u);

        const failedOutput = join(root, "failed-output");
        assert.throws(() =>
          generateSupplyChainMetadata({ ...options, outputRoot: failedOutput })
        );
        assert.equal(existsSync(failedOutput), false);
        assert.equal(
          readdirSync(root).some((name) => name.startsWith("hostdeck-metadata-stage-")),
          false
        );
        writeFileSync(evidenceSidecar, sidecarBytes);

        const occupied = join(root, "occupied");
        mkdirSync(occupied);
        writeFileSync(join(occupied, "sentinel"), "owned");
        assert.throws(() =>
          generateSupplyChainMetadata({ ...options, outputRoot: occupied })
        );
        assert.equal(readFileSync(join(occupied, "sentinel"), "utf8"), "owned");
      } finally {
        rmSync(packageRoot, { force: true, recursive: true });
        rmSync(root, { force: true, recursive: true });
      }
    }
  );
} else {
  test("serializes the bundled Windows release contract natively", () => {
    const documents = createSupplyChainDocuments(fixtureSnapshot("windows-x64"));
    assert.equal(JSON.parse(documents["metadata.json"]).package.target, "windows-x64");
  });
}

function fixtureSnapshot(target) {
  const windows = target === "windows-x64";
  const packageVersion = "1.2.3";
  const targetIdentity = windows
    ? {
        architecture: "x64",
        id: "windows-x64",
        lifecycle: "windows_user_agent",
        platform: "win32",
        publicPackageKind: "windows_msix"
      }
    : {
        architecture: "x64",
        id: "linux-x64",
        lifecycle: "systemd_user",
        platform: "linux",
        publicPackageKind: "linux_archive"
      };
  const nativeModules = nativePackages.map(([name, version], index) => ({
    nodeAbi: "127",
    package: name,
    path: `native/${name}.node`,
    sha256: hash(`native-${index}`),
    size: index + 1,
    target,
    version
  }));
  const manifest = {
    artifact: { kind: "native_tree" },
    content: { bytes: 10, entryCount: 3, sha256: hash("package-tree") },
    manifestSha256: hash("package-manifest-identity"),
    nativeModules,
    packageVersion,
    runtime: {
      architecture: "x64",
      bundle: {
        path: windows ? "runtime/node.exe" : "runtime/bin/node",
        sha256: hash("node-binary"),
        size: 123
      },
      delivery: "bundled",
      node: "22.22.2",
      nodeAbi: "127",
      platform: windows ? "win32" : "linux",
      pnpm: "10.29.2"
    },
    source: {
      commit: "1".repeat(40),
      count: 633,
      sha256: hash("source")
    },
    target: targetIdentity
  };
  const graph = fixtureGraph(packageVersion, target);
  const evidence = {
    native_dependencies: nativePackages.map(([name, version]) => ({ name, version })),
    source: {
      commit: manifest.source.commit,
      lockfile_sha256: hash("lockfile")
    },
    target,
    toolchain: {
      node_module_abi: "127",
      node_version: "22.22.2",
      pnpm_version: "10.29.2"
    },
    workflow: { run_attempt: 1, run_id: "123456789" }
  };
  const packageFiles = {
    bytes: 10,
    files: [
      { path: "app.js", sha256: hash("app"), size: 3 },
      { path: "hostdeck-package.json", sha256: hash("manifest"), size: 7 }
    ]
  };
  return {
    evidence,
    evidenceSha256: hash("evidence"),
    graph,
    lockfileSha256: evidence.source.lockfile_sha256,
    manifest,
    manifestFileSha256: hash("manifest-file"),
    packageFiles,
    verification: {
      contentSha256: manifest.content.sha256,
      entryCount: manifest.content.entryCount,
      outputCount: 10,
      packageVersion,
      sourceCount: 633,
      webBytes: 10,
      webFileCount: 2,
      webSha256: hash("web")
    }
  };
}

function fixtureGraph(packageVersion, target) {
  const dependencyByWorkspace = {
    "@hostdeck/core": [],
    "@hostdeck/contracts": ["@hostdeck/core", "zod"],
    "@hostdeck/codex-adapter": ["@hostdeck/contracts", "@hostdeck/core"],
    "@hostdeck/storage": [
      "@hostdeck/contracts",
      "better-sqlite3",
      "fs-native-extensions",
      "koffi"
    ],
    "@hostdeck/server": [
      "@hostdeck/codex-adapter",
      "@hostdeck/contracts",
      "@hostdeck/core",
      "@hostdeck/storage"
    ],
    "@hostdeck/cli": ["@hostdeck/contracts", "@hostdeck/server", "@hostdeck/storage"],
    "@hostdeck/web": ["@hostdeck/contracts", "@hostdeck/core", "zod"]
  };
  const versions = new Map([...nativePackages, ["zod", "4.4.3"]]);
  const ref = (name) => npmPurl(name, versions.get(name) ?? packageVersion);
  const nodes = workspaceNames.map((name) => ({
    dependencies: dependencyByWorkspace[name].map(ref).sort(),
    directWorkspaceParents: [],
    kind: "workspace",
    licenseExpression: null,
    name,
    native: false,
    notice: null,
    purl: ref(name),
    ref: ref(name),
    version: packageVersion
  }));
  for (const [name, version] of versions) {
    const directWorkspaceParents = workspaceNames
      .filter((workspace) => dependencyByWorkspace[workspace].includes(name))
      .sort();
    nodes.push({
      dependencies: [],
      directWorkspaceParents,
      kind: "npm",
      licenseExpression: "MIT",
      name,
      native: nativePackages.some(([nativeName]) => nativeName === name),
      notice: null,
      purl: npmPurl(name, version),
      ref: npmPurl(name, version),
      version
    });
  }
  const entryRefs = [npmPurl("@hostdeck/cli", packageVersion), npmPurl("@hostdeck/web", packageVersion)];
  const runtimePlatform = target === "windows-x64" ? "win32" : "linux";
  const runtimeRef = `pkg:generic/node@22.22.2?arch=x64&os=${runtimePlatform}`;
  nodes.push({
    dependencies: [],
    directWorkspaceParents: [],
    kind: "runtime",
    licenseExpression: "MIT",
    name: "node",
    native: true,
    notice: { path: "runtime/LICENSE", sha256: hash("node-license") },
    purl: runtimeRef,
    ref: runtimeRef,
    version: "22.22.2"
  });
  entryRefs.push(runtimeRef);
  nodes.sort((left, right) => left.ref.localeCompare(right.ref));
  entryRefs.sort();
  return { entryRefs, nodes };
}

function nativeEvidenceFixture(target, commit, lockfileSha256) {
  const policy = nativeCiTargetPolicies[target];
  return {
    checks: policy.checks.map((id, index) => ({
      duration_ms: index + 1,
      id,
      status: "passed"
    })),
    generated_at: "2026-08-11T12:00:00.000Z",
    native_dependencies: nativePackages.map(([name, version]) => ({ name, version })),
    runner: {
      architecture: policy.architecture,
      image_version: "20260811.1.0",
      label: policy.runner_label,
      node_platform: policy.node_platform,
      os_release: target === "windows-x64" ? "10.0.20348" : "6.8.0-azure"
    },
    source: { commit, lockfile_sha256: lockfileSha256 },
    target,
    toolchain: {
      node_module_abi: "127",
      node_napi: "10",
      node_version: "22.22.2",
      pnpm_version: "10.29.2"
    },
    workflow: {
      event: "push",
      name: "native-ci",
      run_attempt: 1,
      run_id: "123456789"
    }
  };
}

function mutate(value, mutation) {
  const candidate = structuredClone(value);
  mutation(candidate);
  return candidate;
}

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/%40${scope.slice(1)}/${packageName}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
