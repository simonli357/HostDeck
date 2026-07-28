import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const playwrightOutput = join(tmpdir(), "hostdeck-playwright-package");
const browserTemporaryRoot = mkdtempSync(
  join(tmpdir(), "hostdeck-package-browser-run-")
);

let exitCode = 0;
try {
  removeOwnedPath(playwrightOutput);
  exitCode = runPnpm(["build"]);
  if (exitCode === 0) {
    exitCode = runPnpm(
      ["exec", "playwright", "test", "--config", "playwright.package.config.ts"],
      { HOSTDECK_PACKAGE_BROWSER_TEMP_ROOT: browserTemporaryRoot }
    );
  }
} finally {
  removeOwnedPath(playwrightOutput);
  removeOwnedPath(browserTemporaryRoot);
}

process.exitCode = exitCode;

function runPnpm(args, environmentOverrides = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command =
    typeof npmExecPath === "string" && existsSync(npmExecPath)
      ? process.execPath
      : "pnpm";
  const commandArguments =
    command === process.execPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environmentOverrides },
    stdio: "inherit"
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== null) return result.status;
  process.stderr.write(
    `Production package browser command terminated by ${result.signal ?? "an unknown signal"}.\n`
  );
  return 1;
}

function removeOwnedPath(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSymbolicLink()) makeWritable(path, stats);
  rmSync(path, { force: true, recursive: true });
}

function makeWritable(path, stats = lstatSync(path)) {
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      makeWritable(child, lstatSync(child));
    }
    return;
  }
  if (stats.isFile()) chmodSync(path, stats.mode & 0o111 ? 0o755 : 0o644);
}
