import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalManifestSha256,
  fidelityCaptures,
  fidelityTargets,
  pngDimensions,
  repositoryRoot
} from "./ui-fidelity-evidence.mjs";

test("freezes exactly the seven selected Option B raster identities", async () => {
  assert.equal(fidelityTargets.length, 7);
  assert.equal(new Set(fidelityTargets.map(({ id }) => id)).size, 7);
  assert.equal(new Set(fidelityTargets.map(({ path }) => path)).size, 7);
  for (const target of fidelityTargets) {
    assert.match(target.path, /^assets\/ui-concepts\/option-b\/.+\.png$/u);
    const dimensions = pngDimensions(await readFile(resolve(repositoryRoot, target.path)));
    assert.deepEqual(dimensions, { width: target.width, height: target.height });
  }
});

test("binds 23 fresh screenshots across all selected target families", () => {
  assert.equal(fidelityCaptures.length, 23);
  assert.equal(new Set(fidelityCaptures.map(({ file }) => file)).size, 23);
  assert.deepEqual(
    new Set(fidelityCaptures.map(({ target }) => target)),
    new Set(fidelityTargets.map(({ id }) => id))
  );
});

test("rejects truncated or non-PNG headers", () => {
  assert.throws(() => pngDimensions(Buffer.alloc(23)), /truncated/u);
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /decodable PNG header/u);
});

test("canonical manifest identity ignores only its own digest and key order", () => {
  const left = { schema_version: 1, nested: { beta: 2, alpha: 1 }, manifest_sha256: "old" };
  const right = { nested: { alpha: 1, beta: 2 }, manifest_sha256: "changed", schema_version: 1 };
  assert.equal(canonicalManifestSha256(left), canonicalManifestSha256(right));
  right.nested.beta = 3;
  assert.notEqual(canonicalManifestSha256(left), canonicalManifestSha256(right));
});
