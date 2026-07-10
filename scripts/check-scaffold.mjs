import { existsSync, readFileSync } from "node:fs";
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

const rootFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  ".nvmrc"
];

const requiredScripts = [
  "check:scaffold",
  "check:planning",
  "check:codex-bindings",
  "generate:codex-bindings",
  "typecheck",
  "lint",
  "test",
  "test:unit",
  "test:contract",
  "test:integration",
  "test:tmux",
  "smoke:codex-compatibility",
  "test:web",
  "test:e2e",
  "build",
  "smoke:local"
];

function requireFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required scaffold file: ${path}`);
  }
}

function readJson(path) {
  requireFile(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const file of rootFiles) {
  requireFile(file);
}

const rootPackage = readJson("package.json");

for (const script of requiredScripts) {
  if (typeof rootPackage.scripts?.[script] !== "string") {
    throw new Error(`Missing root script: ${script}`);
  }
}

for (const packageName of packages) {
  const packageDir = join("packages", packageName);
  const manifest = readJson(join(packageDir, "package.json"));

  if (manifest.name !== `@hostdeck/${packageName}`) {
    throw new Error(`Unexpected package name for ${packageDir}: ${manifest.name}`);
  }

  requireFile(join(packageDir, "tsconfig.json"));
  requireFile(join(packageDir, "src", "index.ts"));
}

console.log(`HostDeck scaffold OK: ${packages.length} packages and ${requiredScripts.length} root scripts.`);
