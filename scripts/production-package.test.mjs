import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";

import {
  createProductionDependencyDeployArguments,
  createProductionWebBuildEnvironment,
  createRuntimePackageManifest,
  inspectViteManifest,
  normalizeDeployedWorkspaceLayout,
  publishCompletedPackage,
  selectedProductionSources
} from "./build-production-package.mjs";
import {
  computeFileIdentity,
  computeManifestSha256,
  createProductionWebManifest,
  productionPackageSourceCount,
  productionWebBrowserRoutes,
  productionWebManifestName,
  productionWebViteVersion,
  stableJson,
  verifyProductionWebAssets
} from "./verify-production-package.mjs";

const deployedWorkspacePackageNames = ["core", "contracts", "codex-adapter", "storage", "server"];
const deployedExternalPackageNames = ["fs-ext", "qrcode", "zod"];

function createWorkspaceDeployEntry(root, name, index) {
  const entryName = `@hostdeck+${name}@file++++private+checkout+packages+${name}_${index}`;
  const packageRoot = join(
    root,
    "node_modules",
    ".pnpm",
    entryName,
    "node_modules",
    "@hostdeck",
    name
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: `@hostdeck/${name}` })}\n`);
  return { entryName, packageRoot };
}

function createSharedDeployFixture(root, packageNames = deployedWorkspacePackageNames) {
  const packages = new Map(
    packageNames.map((name, index) => [name, createWorkspaceDeployEntry(root, name, index)])
  );
  let topLevelLink;
  if (packages.has("contracts")) {
    topLevelLink = join(root, "node_modules", "@hostdeck", "contracts");
    mkdirSync(dirname(topLevelLink), { recursive: true });
    symlinkSync(relative(dirname(topLevelLink), packages.get("contracts").packageRoot), topLevelLink, "dir");
  }
  let crossPackageLink;
  if (packages.has("server") && packages.has("core")) {
    crossPackageLink = join(packages.get("server").packageRoot, "node_modules", "@hostdeck", "core");
    mkdirSync(dirname(crossPackageLink), { recursive: true });
    symlinkSync(relative(dirname(crossPackageLink), packages.get("core").packageRoot), crossPackageLink, "dir");
  }
  for (const name of deployedExternalPackageNames) {
    const packageRoot = join(root, "node_modules", ".pnpm", `${name}@1.0.0`, "node_modules", name);
    const link = join(root, "node_modules", name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name })}\n`);
    symlinkSync(relative(dirname(link), packageRoot), link, "dir");
  }
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      dependencies: Object.fromEntries(deployedExternalPackageNames.map((name) => [name, "1.0.0"]))
    })}\n`
  );
  return {
    packageNames: [...packageNames],
    topLevelLink
  };
}

test("selects the exact non-web production closure", () => {
  const sources = selectedProductionSources();
  assert.equal(sources.length, productionPackageSourceCount);
  assert.equal(sources.some((path) => path.startsWith("packages/web/")), false);
  assert.deepEqual(
    sources.filter((path) =>
      [
        "packages/cli/src/device-revoke-client.ts",
        "packages/cli/src/host-status-client.ts",
        "packages/cli/src/local-device-list.ts",
        "packages/cli/src/service-host.ts",
        "packages/cli/src/session-list-client.ts",
        "packages/cli/src/systemd-user-units.ts",
        "packages/contracts/src/browser-http-resource-policy.ts",
        "packages/server/src/foreground-resource-bootstrap.ts",
        "packages/server/src/production-application-composition.ts",
        "packages/server/src/production-foreground-serve.ts",
        "packages/storage/src/read-only-database.ts"
      ].includes(path)
    ),
    [
      "packages/cli/src/device-revoke-client.ts",
      "packages/cli/src/host-status-client.ts",
      "packages/cli/src/local-device-list.ts",
      "packages/cli/src/service-host.ts",
      "packages/cli/src/session-list-client.ts",
      "packages/cli/src/systemd-user-units.ts",
      "packages/contracts/src/browser-http-resource-policy.ts",
      "packages/server/src/foreground-resource-bootstrap.ts",
      "packages/server/src/production-application-composition.ts",
      "packages/server/src/production-foreground-serve.ts",
      "packages/storage/src/read-only-database.ts"
    ]
  );
  assert.deepEqual(
    [...new Set(sources.map((path) => path.split("/")[1]))].sort(),
    ["cli", "codex-adapter", "contracts", "core", "server", "storage"]
  );
});

test("rewrites source manifests to exact runtime-only package metadata", () => {
  const manifest = createRuntimePackageManifest(
    {
      name: "@hostdeck/cli",
      version: "0.0.0",
      bin: { codexdeck: "./src/shell.ts" },
      scripts: { test: "vitest" },
      dependencies: {
        zod: "4.4.3",
        "@hostdeck/core": "workspace:*"
      },
      devDependencies: { typescript: "7.0.2" }
    },
    "0.0.0",
    "22.22.2"
  );
  assert.deepEqual(manifest, {
    name: "@hostdeck/cli",
    version: "0.0.0",
    private: true,
    type: "module",
    bin: { codexdeck: "./dist/shell.js" },
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }
    },
    engines: { node: "22.22.2" },
    dependencies: {
      "@hostdeck/core": "0.0.0",
      zod: "4.4.3"
    }
  });
  assert.equal("scripts" in manifest, false);
  assert.equal("devDependencies" in manifest, false);
});

test("uses the frozen shared-lockfile production deploy path", () => {
  const deployRoot = join(tmpdir(), "hostdeck-production-deploy");
  const args = createProductionDependencyDeployArguments(deployRoot);
  assert.deepEqual(args, [
    "--offline",
    "--frozen-lockfile",
    "--filter",
    "@hostdeck/cli",
    "deploy",
    "--prod",
    deployRoot
  ]);
  assert.equal(args.includes("--legacy"), false);
  assert.equal(Object.isFrozen(args), true);
  assert.throws(
    () => createProductionDependencyDeployArguments("relative/deploy"),
    /must be absolute/u
  );
});

test("normalizes source-derived workspace deploy paths and links", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-shared-deploy-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const fixture = createSharedDeployFixture(root);

  const result = normalizeDeployedWorkspaceLayout(root);
  assert.deepEqual(result.packageNames, fixture.packageNames);
  assert.equal(result.rewrittenLinkCount, 2);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.packageNames), true);

  const virtualStoreRoot = join(root, "node_modules", ".pnpm");
  assert.deepEqual(
    readdirSync(virtualStoreRoot)
      .filter((name) => name.startsWith("@hostdeck+"))
      .sort(),
    fixture.packageNames
      .map((name) => `@hostdeck+${name}@file+packages+${name}`)
      .sort()
  );
  for (const name of fixture.packageNames) {
    const packageRoot = join(
      virtualStoreRoot,
      `@hostdeck+${name}@file+packages+${name}`,
      "node_modules",
      "@hostdeck",
      name
    );
    assert.equal(
      realpathSync(join(virtualStoreRoot, "node_modules", "@hostdeck", name)),
      packageRoot
    );
  }
  assert.equal(readlinkSync(fixture.topLevelLink).includes("private+checkout"), false);
  const normalizedCrossPackageLink = join(
    virtualStoreRoot,
    "@hostdeck+server@file+packages+server",
    "node_modules",
    "@hostdeck",
    "server",
    "node_modules",
    "@hostdeck",
    "core"
  );
  assert.equal(readlinkSync(normalizedCrossPackageLink).includes("private+checkout"), false);
  assert.equal(normalizeDeployedWorkspaceLayout(root).rewrittenLinkCount, 0);
});

test("rejects incomplete, unexpected, duplicate, and dependency-drifted workspace deploy layouts", (context) => {
  const incomplete = mkdtempSync(join(tmpdir(), "hostdeck-shared-incomplete-"));
  const unexpected = mkdtempSync(join(tmpdir(), "hostdeck-shared-unexpected-"));
  const duplicate = mkdtempSync(join(tmpdir(), "hostdeck-shared-duplicate-"));
  const dependencyDrift = mkdtempSync(join(tmpdir(), "hostdeck-shared-dependency-drift-"));
  context.after(() => {
    for (const root of [incomplete, unexpected, duplicate, dependencyDrift]) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  createSharedDeployFixture(incomplete, ["core"]);
  assert.throws(
    () => normalizeDeployedWorkspaceLayout(incomplete),
    /package set is incomplete/u
  );

  createWorkspaceDeployEntry(unexpected, "unknown", 0);
  assert.throws(
    () => normalizeDeployedWorkspaceLayout(unexpected),
    /unexpected package/u
  );

  createSharedDeployFixture(duplicate);
  createWorkspaceDeployEntry(duplicate, "core", 99);
  assert.throws(
    () => normalizeDeployedWorkspaceLayout(duplicate),
    /duplicate @hostdeck\/core/u
  );

  createSharedDeployFixture(dependencyDrift);
  writeFileSync(
    join(dependencyDrift, "package.json"),
    `${JSON.stringify({ dependencies: { extra: "1.0.0" } })}\n`
  );
  assert.throws(
    () => normalizeDeployedWorkspaceLayout(dependencyDrift),
    /external dependencies changed/u
  );
});

test("file identity is path-sensitive, ordered, and deterministic", () => {
  const first = computeFileIdentity([
    { path: "b.js", content: "two" },
    { path: "a.js", content: "one" }
  ]);
  const second = computeFileIdentity([
    { path: "a.js", content: "one" },
    { path: "b.js", content: "two" }
  ]);
  const changed = computeFileIdentity([
    { path: "a.js", content: "one" },
    { path: "c.js", content: "two" }
  ]);
  assert.deepEqual(second, first);
  assert.notEqual(changed.sha256, first.sha256);
  assert.throws(
    () => computeFileIdentity([{ path: "same", content: "one" }, { path: "same", content: "two" }]),
    /duplicated/u
  );
});

test("manifest identity is canonical and excludes only its own digest field", () => {
  const left = { schemaVersion: 1, nested: { beta: 2, alpha: 1 }, manifestSha256: "old" };
  const right = { nested: { alpha: 1, beta: 2 }, schemaVersion: 1, manifestSha256: "changed" };
  assert.equal(stableJson(left.nested), stableJson(right.nested));
  assert.equal(computeManifestSha256(left), computeManifestSha256(right));
  assert.notEqual(
    computeManifestSha256({ ...right, schemaVersion: 2 }),
    computeManifestSha256(right)
  );
});

test("isolates the production web build from ambient environment values", () => {
  const secretCanary = "hostdeck-private-build-canary-001";
  const proxyCanary = "http://private-proxy.invalid:8080";
  const result = createProductionWebBuildEnvironment({
    HOME: "/private/home",
    HOSTDECK_RANDOM_SETTING: "hidden",
    HTTPS_PROXY: proxyCanary,
    PATH: "/usr/local/bin:/usr/bin",
    RANDOM_AMBIENT_VALUE: "not-exported",
    VITE_HOSTDECK_TOKEN: secretCanary
  });
  assert.deepEqual(result.env, {
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    NO_UPDATE_NOTIFIER: "1",
    PATH: "/usr/local/bin:/usr/bin",
    TZ: "UTC",
    npm_config_offline: "true"
  });
  assert.deepEqual(
    result.privateValues.map((value) => value.toString("utf8")),
    [proxyCanary, secretCanary]
  );
  assert.equal(Object.isFrozen(result.env), true);
  assert.equal(Object.isFrozen(result.privateValues), true);
  assert.throws(
    () => createProductionWebBuildEnvironment({ PATH: "" }),
    /build PATH is invalid/u
  );
});

test("disables Vite environment-file loading for production web builds", async () => {
  const expectedRoot = fileURLToPath(
    new URL("../packages/web/", import.meta.url)
  );
  const config = await resolveConfig(
    {
      configFile: fileURLToPath(
        new URL("../packages/web/vite.config.ts", import.meta.url)
      ),
      logLevel: "silent"
    },
    "build",
    "production"
  );
  assert.equal(config.envDir, false);
  assert.equal(config.root, expectedRoot.replace(/\/$/u, ""));
  assert.equal(config.publicDir, "");
  assert.deepEqual(config.css.postcss, {});
});

test("accepts only the complete Vite graph rooted at one HTML entry", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-vite-manifest-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>\n");
  const paths = [
    "assets/chunk-87654321.js",
    "assets/index-12345678.css",
    "assets/index-ABCDEFGH.js"
  ];
  for (const path of paths) {
    writeFileSync(join(root, ...path.split("/")), `${path}\n`);
  }
  const valid = {
    "_chunk.js": {
      file: "assets/chunk-87654321.js",
      name: "chunk",
      src: "src/chunk.ts"
    },
    "index.html": {
      css: ["assets/index-12345678.css"],
      file: "assets/index-ABCDEFGH.js",
      imports: ["_chunk.js"],
      isEntry: true,
      name: "index",
      src: "index.html"
    }
  };
  assert.deepEqual(inspectViteManifest(valid, root), {
    assetPaths: paths,
    entryAssets: [
      "assets/index-12345678.css",
      "assets/index-ABCDEFGH.js"
    ]
  });

  const unknownField = structuredClone(valid);
  unknownField["index.html"].unexpected = true;
  assert.throws(
    () => inspectViteManifest(unknownField, root),
    /entry fields are invalid/u
  );

  const danglingReference = structuredClone(valid);
  danglingReference["index.html"].imports = ["missing.js"];
  assert.throws(
    () => inspectViteManifest(danglingReference, root),
    /imports references are invalid/u
  );

  const unreachable = structuredClone(valid);
  unreachable["unused.js"] = { file: "assets/unused-12345678.js" };
  assert.throws(
    () => inspectViteManifest(unreachable, root),
    /unreachable output record/u
  );

  const duplicateFile = structuredClone(valid);
  duplicateFile["duplicate.js"] = { file: "assets/chunk-87654321.js" };
  duplicateFile["index.html"].imports.push("duplicate.js");
  assert.throws(
    () => inspectViteManifest(duplicateFile, root),
    /claimed by multiple records/u
  );

  const duplicateAssociated = structuredClone(valid);
  duplicateAssociated["_chunk.js"].assets = [
    "assets/index-12345678.css"
  ];
  assert.throws(
    () => inspectViteManifest(duplicateAssociated, root),
    /claimed by multiple records/u
  );

  const secondEntry = structuredClone(valid);
  secondEntry["_chunk.js"].isEntry = true;
  secondEntry["_chunk.js"].src = "index.html";
  assert.throws(
    () => inspectViteManifest(secondEntry, root),
    /one index entry/u
  );

  const malformedFlag = structuredClone(valid);
  malformedFlag["index.html"].isEntry = "true";
  assert.throws(
    () => inspectViteManifest(malformedFlag, root),
    /isEntry flag is invalid/u
  );

  const escapingOutput = structuredClone(valid);
  escapingOutput["index.html"].file = "../index-ABCDEFGH.js";
  assert.throws(
    () => inspectViteManifest(escapingOutput, root),
    /output file is invalid/u
  );

  writeFileSync(join(root, "assets", "extra-12345678.js"), "extra\n");
  assert.throws(
    () => inspectViteManifest(valid, root),
    /does not exactly describe emitted assets/u
  );
});

test("constructs and verifies one deterministic production web identity", (context) => {
  const fixture = createWebFixture(context);
  const first = createProductionWebManifest(fixture.input);
  const second = createProductionWebManifest(fixture.input);
  assert.deepEqual(second, first);
  assert.deepEqual(first.browserRoutes, productionWebBrowserRoutes);
  assert.equal(first.packageVersion, "0.0.0");
  assert.equal(first.viteVersion, productionWebViteVersion);
  assert.equal(first.assets.length, 2);
  assert.equal(first.content.count, 3);

  writeWebFixture(fixture.root, fixture.input, first);
  const verified = verifyProductionWebAssets(fixture.root);
  assert.deepEqual(verified.browserRoutes, productionWebBrowserRoutes);
  assert.equal(verified.fileCount, 3);
  assert.equal(verified.assetCount, 2);
  assert.equal(verified.sha256, first.content.sha256);
  assert.equal(verified.bytes, first.content.bytes);
});

test("rejects production web identity, inventory, and mode mutations", async (context) => {
  await context.test("asset bytes", () => {
    const fixture = createVerifiedWebFixture(context, "asset-bytes");
    writeFileSync(join(fixture.root, "assets", "index-ABCDEFGH.js"), "export const changed = true;\n");
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /file identity is invalid/u
    );
  });

  await context.test("index version marker", () => {
    const fixture = createVerifiedWebFixture(context, "index-version");
    const indexPath = join(fixture.root, "index.html");
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace('content="0.0.0"', 'content="9.9.9"')
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /file identity is invalid/u
    );
  });

  await context.test("coherently resigned invalid index marker", () => {
    const fixture = createWebFixture(context, "resigned-index-version");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: fixture.input.index.content.replace(
          'content="0.0.0"',
          'content="9.9.9"'
        )
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /package-version marker is invalid/u
    );
  });

  await context.test("coherently resigned undeclared index reference", () => {
    const fixture = createWebFixture(context, "resigned-index-reference");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: fixture.input.index.content.replace(
          "/assets/index-ABCDEFGH.js",
          "/assets/other-ABCDEFGH.js"
        )
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /entry references are inconsistent/u
    );
  });

  await context.test("coherently resigned duplicate version marker", () => {
    const fixture = createWebFixture(context, "resigned-duplicate-version");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: fixture.input.index.content.replace(
          "</head>",
          '<meta name="hostdeck-package-version" content="0.0.0"></head>'
        )
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /package-version marker is invalid/u
    );
  });

  await context.test("coherently resigned document-structure drift", () => {
    const fixture = createWebFixture(context, "resigned-document-structure");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: fixture.input.index.content.replace(
          "<title>HostDeck</title>",
          ""
        )
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /document structure is invalid/u
    );
  });

  await context.test("coherently resigned foreign document reference", () => {
    const fixture = createWebFixture(context, "resigned-foreign-reference");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: fixture.input.index.content.replace(
          "</body>",
          '<img src="/foreign.png"></body>'
        )
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /entry references are inconsistent/u
    );
  });

  await context.test("coherently resigned invalid UTF-8 index", () => {
    const fixture = createWebFixture(context, "resigned-invalid-utf8");
    const changedInput = {
      ...fixture.input,
      index: {
        ...fixture.input.index,
        content: Buffer.concat([
          Buffer.from(fixture.input.index.content),
          Buffer.from([0xff])
        ])
      }
    };
    writeWebFixture(
      fixture.root,
      changedInput,
      createProductionWebManifest(changedInput)
    );
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /not valid UTF-8/u
    );
  });

  await context.test("case-colliding asset descriptors", () => {
    const fixture = createWebFixture(context, "case-collision");
    const changedInput = {
      ...fixture.input,
      assets: [
        ...fixture.input.assets,
        { content: "export {};\n", path: "assets/INDEX-ABCDEFGH.js" }
      ].sort((left, right) => left.path.localeCompare(right.path))
    };
    assert.throws(
      () => createProductionWebManifest(changedInput),
      /case-unique/u
    );
  });

  await context.test("oversized index input", () => {
    const fixture = createWebFixture(context, "oversized-index");
    assert.throws(
      () =>
        createProductionWebManifest({
          ...fixture.input,
          index: {
            ...fixture.input.index,
            content: Buffer.alloc(2_097_153, 0x20)
          }
        }),
      /file size is invalid/u
    );
  });

  await context.test("extra asset", () => {
    const fixture = createVerifiedWebFixture(context, "extra-asset");
    writeFileSync(join(fixture.root, "assets", "late-12345678.js"), "export {};\n", {
      mode: 0o644
    });
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /inventory does not match/u
    );
  });

  await context.test("extra empty asset directory", () => {
    const fixture = createVerifiedWebFixture(context, "extra-asset-directory");
    mkdirSync(join(fixture.root, "assets", "undeclared"), { mode: 0o755 });
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /directory inventory does not match/u
    );
  });

  await context.test("symbolic web root", () => {
    const fixture = createVerifiedWebFixture(context, "symbolic-root");
    const linkedRoot = `${fixture.root}-link`;
    symlinkSync(fixture.root, linkedRoot, "dir");
    context.after(() => rmSync(linkedRoot, { force: true }));
    assert.throws(
      () => verifyProductionWebAssets(linkedRoot),
      /web root must be one real directory/u
    );
  });

  await context.test("route drift", () => {
    const fixture = createVerifiedWebFixture(context, "route-drift");
    const manifestPath = join(fixture.root, productionWebManifestName);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.browserRoutes = ["/"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /browser routes are inconsistent/u
    );
  });

  await context.test("group-writable index", () => {
    const fixture = createVerifiedWebFixture(context, "index-mode");
    chmodSync(join(fixture.root, "index.html"), 0o664);
    assert.throws(
      () => verifyProductionWebAssets(fixture.root),
      /file mode is invalid/u
    );
  });
});

test("rejects non-exact runtime dependency versions", () => {
  assert.throws(
    () =>
      createRuntimePackageManifest(
        { name: "@hostdeck/example", dependencies: { zod: "^4.4.3" } },
        "0.0.0",
        "22.22.2"
      ),
    /not pinned exactly/u
  );
  assert.throws(
    () =>
      createRuntimePackageManifest(
        {
          name: "@hostdeck/cli",
          bin: { codexdeck: "./src/other.ts" }
        },
        "0.0.0",
        "22.22.2"
      ),
    /source bin metadata is invalid/u
  );
  assert.throws(
    () =>
      createRuntimePackageManifest(
        {
          name: "@hostdeck/server",
          bin: { unexpected: "./src/index.ts" }
        },
        "0.0.0",
        "22.22.2"
      ),
    /must not declare runtime commands/u
  );
});

test("publishes complete trees and restores the current tree when publication fails", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-package-publish-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const output = join(root, "hostdeck");
  const staged = join(root, "staged");
  mkdirSync(output);
  mkdirSync(staged);
  writeFileSync(join(output, "identity"), "stale");
  writeFileSync(join(staged, "identity"), "current");

  publishCompletedPackage(staged, output);
  assert.equal(readFileSync(join(output, "identity"), "utf8"), "current");
  assert.equal(existsSync(staged), false);

  assert.throws(
    () => publishCompletedPackage(join(root, "missing-stage"), output),
    /Unable to publish/u
  );
  assert.equal(readFileSync(join(output, "identity"), "utf8"), "current");
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".hostdeck-previous-")),
    []
  );
});

function createWebFixture(context, label = "identity") {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-web-${label}-`));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const javascript = "export const hostDeckWeb = true;\n";
  const stylesheet = "body { color: black; }\n";
  const index =
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#121313"><meta name="hostdeck-package-version" content="0.0.0"><title>HostDeck</title><script type="module" src="/assets/index-ABCDEFGH.js"></script><link rel="stylesheet" href="/assets/index-12345678.css"></head><body><div id="root"></div></body></html>\n';
  return {
    root,
    input: {
      assets: [
        { content: stylesheet, path: "assets/index-12345678.css" },
        { content: javascript, path: "assets/index-ABCDEFGH.js" }
      ],
      browserRoutes: productionWebBrowserRoutes,
      entryAssets: [
        "assets/index-12345678.css",
        "assets/index-ABCDEFGH.js"
      ],
      index: { content: index, path: "index.html" },
      packageVersion: "0.0.0",
      viteVersion: productionWebViteVersion
    }
  };
}

function createVerifiedWebFixture(context, label) {
  const fixture = createWebFixture(context, label);
  writeWebFixture(
    fixture.root,
    fixture.input,
    createProductionWebManifest(fixture.input)
  );
  assert.doesNotThrow(() => verifyProductionWebAssets(fixture.root));
  return fixture;
}

function writeWebFixture(root, input, manifest) {
  mkdirSync(join(root, "assets"), { mode: 0o755, recursive: true });
  writeFileSync(join(root, "index.html"), input.index.content, { mode: 0o644 });
  for (const asset of input.assets) {
    writeFileSync(join(root, ...asset.path.split("/")), asset.content, {
      mode: 0o644
    });
  }
  writeFileSync(
    join(root, productionWebManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 }
  );
  chmodSync(root, 0o755);
  chmodSync(join(root, "assets"), 0o755);
}
