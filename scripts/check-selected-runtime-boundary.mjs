import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const failures = [];
const removedServerModules = [
  "host-service",
  "output-reader",
  "read-routes",
  "restart-reconciler",
  "session-control-routes",
  "startup",
  "stream-routes",
  "write-routes"
];

if (existsSync("packages/tmux-adapter/package.json")) {
  failures.push("packages/tmux-adapter must not be a workspace package");
}

const rootPackage = readJson("package.json");
if (rootPackage.scripts?.["test:tmux"] !== undefined) {
  failures.push("the historical test:tmux script must not exist");
}
const lockfile = readFile("pnpm-lock.yaml");
if (lockfile.includes("packages/tmux-adapter") || lockfile.includes("'@hostdeck/tmux-adapter'")) {
  failures.push("pnpm-lock.yaml retains the removed tmux workspace package");
}

const serverPackage = readJson("packages/server/package.json");
for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  if (serverPackage[section]?.["@hostdeck/tmux-adapter"] !== undefined) {
    failures.push(`@hostdeck/server ${section} must not contain @hostdeck/tmux-adapter`);
  }
}

const serverIndex = readFile("packages/server/src/index.ts");
for (const moduleName of removedServerModules) {
  if (serverIndex.includes(`./${moduleName}.js`)) {
    failures.push(`@hostdeck/server must not export ${moduleName}`);
  }
  if (existsSync(`packages/server/src/${moduleName}.ts`)) {
    failures.push(`removed runtime module still exists: ${moduleName}.ts`);
  }
}

for (const path of sourceFiles("packages")) {
  const source = readFile(path);
  if (source.includes("@hostdeck/tmux-adapter")) {
    failures.push(`${path} imports the removed tmux adapter`);
  }
  if (!isTestFile(path) && /(?:execFile|spawn|spawnSync)\s*\([^\n]*["'`]tmux["'`]/u.test(source)) {
    failures.push(`${path} invokes tmux from production source`);
  }
}

for (const path of [
  "packages/cli/src/api-client.ts",
  "packages/cli/src/parser.ts",
  "packages/cli/src/render.ts",
  "packages/cli/src/shell.ts"
]) {
  if (/\btmux\b/iu.test(readFile(path))) {
    failures.push(`${path} retains a tmux-shaped CLI surface`);
  }
}

if (!existsSync("packages/storage/src/legacy-session-repository.ts")) {
  failures.push("legacy session disposition/reset repository is missing");
}

if (failures.length > 0) {
  throw new Error(`Selected runtime boundary failed:\n- ${failures.join("\n- ")}`);
}

console.log("Selected runtime boundary OK: app-server only; tmux remains test-terminal-only.");

function readFile(path) {
  return readFileSync(path, "utf8");
}

function readJson(path) {
  return JSON.parse(readFile(path));
}

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".mjs"))) {
      files.push(path);
    }
  }
  return files;
}

function isTestFile(path) {
  return /\.(?:contract\.|integration\.|smoke\.|probe\.)?test\.ts$/u.test(path);
}
