import { readFileSync } from "node:fs";
import { join } from "node:path";

const packages = [
  "core",
  "contracts",
  "codex-adapter",
  "test-fixtures",
  "storage",
  "tmux-adapter",
  "server",
  "cli",
  "web"
];

const expectedEntry = "./src/index.ts";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const packageName of packages) {
  const packageDir = join("packages", packageName);
  const manifest = readJson(join(packageDir, "package.json"));
  const expectedName = `@hostdeck/${packageName}`;

  if (manifest.name !== expectedName) {
    throw new Error(`${packageDir} must be named ${expectedName}`);
  }

  if (manifest.private !== true) {
    throw new Error(`${expectedName} must stay private until packaging policy changes`);
  }

  if (manifest.type !== "module") {
    throw new Error(`${expectedName} must use ESM package type`);
  }

  if (manifest.types !== expectedEntry) {
    throw new Error(`${expectedName} must expose types from ${expectedEntry}`);
  }

  const rootExport = manifest.exports?.["."];

  if (rootExport?.types !== expectedEntry || rootExport?.import !== expectedEntry) {
    throw new Error(`${expectedName} must export ${expectedEntry} for types and import`);
  }

  if (manifest.scripts?.typecheck !== "tsc --noEmit -p tsconfig.json") {
    throw new Error(`${expectedName} must expose the shared typecheck script`);
  }
}

console.log(`HostDeck package exports OK: ${packages.length} packages.`);
