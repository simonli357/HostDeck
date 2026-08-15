import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeterministicPackageArchive } from "./release-bundle.mjs";

const archiveTest = process.platform === "linux" ? test : test.skip;

archiveTest("creates byte-identical normalized archives with one HostDeck root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-release-archive-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const packageRoot = join(root, "candidate");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "README.md"), "HostDeck\n", { mode: 0o644 });
  writeFileSync(join(packageRoot, "bin", "codexdeck"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755
  });
  chmodSync(join(packageRoot, "bin", "codexdeck"), 0o755);
  symlinkSync("bin/codexdeck", join(packageRoot, "codexdeck"));

  const firstPath = join(root, "first.tar.gz");
  const secondPath = join(root, "second.tar.gz");
  const first = createDeterministicPackageArchive(packageRoot, firstPath);
  const second = createDeterministicPackageArchive(packageRoot, secondPath);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(readFileSync(firstPath), readFileSync(secondPath));
  const entries = execFileSync("tar", ["-tzf", firstPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.equal(entries.every((entry) => entry === "hostdeck/" || entry.startsWith("hostdeck/")), true);
  const extractionRoot = join(root, "extracted");
  mkdirSync(extractionRoot);
  execFileSync("tar", ["-xzf", firstPath, "-C", extractionRoot]);
  assert.equal(readlinkSync(join(extractionRoot, "hostdeck", "codexdeck")), "bin/codexdeck");

  writeFileSync(join(packageRoot, "README.md"), "changed\n", { mode: 0o644 });
  const changed = createDeterministicPackageArchive(packageRoot, join(root, "changed.tar.gz"));
  assert.notEqual(changed.sha256, first.sha256);
});

archiveTest("rejects occupied and non-gzip archive outputs", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-release-archive-policy-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const packageRoot = join(root, "candidate");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "file"), "content", { mode: 0o644 });
  const occupied = join(root, "occupied.tar.gz");
  writeFileSync(occupied, "occupied", { mode: 0o644 });
  assert.throws(
    () => createDeterministicPackageArchive(packageRoot, occupied),
    /already exists/u
  );
  assert.throws(
    () => createDeterministicPackageArchive(packageRoot, join(root, "archive.zip")),
    /path is invalid/u
  );
});
