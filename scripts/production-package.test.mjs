import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRuntimePackageManifest,
  publishCompletedPackage,
  selectedProductionSources
} from "./build-production-package.mjs";
import {
  computeFileIdentity,
  computeManifestSha256,
  productionPackageSourceCount,
  stableJson
} from "./verify-production-package.mjs";

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
