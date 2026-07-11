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
  "smoke:codex-ipc",
  "smoke:codex-threads",
  "smoke:codex-semantics",
  "smoke:codex-model",
  "smoke:codex-goal",
  "smoke:codex-plan",
  "smoke:codex-usage",
  "smoke:codex-compact",
  "smoke:codex-skills",
  "smoke:codex-prompt",
  "smoke:codex-approval",
  "smoke:codex-interrupt",
  "smoke:codex-vertical",
  "test:codex",
  "test:web",
  "test:e2e",
  "build",
  "smoke:local"
];

const requiredScriptCommands = {
  "test:codex": "pnpm smoke:codex-vertical",
  "test:e2e": "node scripts/not-implemented.mjs test:e2e IFC-V1-046 FE-V1-040",
  build: "node scripts/not-implemented.mjs build IFC-V1-021",
  "smoke:local": "node scripts/not-implemented.mjs smoke:local REL-V1-006"
};

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

for (const [script, expectedCommand] of Object.entries(requiredScriptCommands)) {
  const actualCommand = rootPackage.scripts?.[script];

  if (actualCommand !== expectedCommand) {
    throw new Error(`Root script ${script} must be ${JSON.stringify(expectedCommand)}, received ${JSON.stringify(actualCommand)}`);
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
