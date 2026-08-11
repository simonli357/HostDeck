import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeWindowsFileSecurityPort } from "../packages/storage/src/windows-native-file-security.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const exactWindowsCodexSha256 =
  "2b3c18d9393ed794531ae3da13f43a6de3bcd91dc577222bd31a17c59f7de0aa";
const windowsStructuredVerticalReportName =
  "windows-structured-vertical-report.json";

main();

function main() {
  const command = parseArguments(process.argv.slice(2));
  requireCondition(
    process.platform === "win32" && process.arch === "x64",
    "Windows Codex vertical requires native Windows x64."
  );
  requireCondition(
    realpathSync(process.cwd()) === repositoryRoot,
    "Windows Codex vertical must run from the repository root."
  );
  if (command.mode === "run") {
    requireCondition(
      realpathSync(dirname(command.outputPath)) === realpathSync(tmpdir()) &&
        basename(command.outputPath) === windowsStructuredVerticalReportName &&
        !existsSync(command.outputPath),
      "Windows Codex vertical output path is invalid."
    );
  }
  const status = runGit(["status", "--porcelain", "--untracked-files=all"]);
  requireCondition(
    status.trim() === "",
    "Windows Codex vertical requires a clean worktree."
  );
  const commit = runGit(["rev-parse", "HEAD"]).trim();
  requireCondition(
    /^[0-9a-f]{40}$/u.test(commit),
    "Windows Codex vertical source commit is invalid."
  );
  if (command.mode === "run") requireAuthentication();

  const runtime = locateExactRuntime();
  const root = mkdtempSync(join(realpathSync(tmpdir()), "hostdeck-windows-vertical-"));
  secureCurrentUserOnly(root, "directory");
  const codexBin = join(root, "codex.exe");
  const codeModeHost = join(root, "codex-code-mode-host.exe");
  let primaryError = null;
  try {
    copyFileSync(runtime.codexBin, codexBin, constants.COPYFILE_EXCL);
    copyFileSync(
      runtime.codeModeHost,
      codeModeHost,
      constants.COPYFILE_EXCL
    );
    secureCurrentUserOnly(codexBin, "file");
    secureCurrentUserOnly(codeModeHost, "file");
    requireCondition(
      sha256File(codexBin) === exactWindowsCodexSha256 &&
        sha256File(codeModeHost) === runtime.codeModeHostSha256 &&
        lstatSync(codexBin).nlink === 1 &&
        lstatSync(codeModeHost).nlink === 1,
      "Windows Codex vertical isolated binary identity is invalid."
    );
    if (command.mode === "run") {
      const pnpm = resolvePnpmInvocation();
      const result = spawnSync(
        pnpm.command,
        [
          ...pnpm.arguments,
          "exec",
          "vitest",
          "run",
          "packages/server/src/codex-structured-vertical.smoke.test.ts"
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE: "1",
            HOSTDECK_CODEX_VERTICAL_TARGET: "windows-x64",
            HOSTDECK_CODEX_BIN: codexBin,
            HOSTDECK_CODEX_VERTICAL_REPORT: command.outputPath,
            NO_COLOR: "1"
          },
          maxBuffer: 2 * 1_024 * 1_024,
          shell: false,
          timeout: 10 * 60_000,
          windowsHide: true
        }
      );
      requireCondition(
        result.error === undefined &&
          result.signal === null &&
          result.status === 0,
        "Windows Codex vertical execution failed."
      );
      const report = readProducedReport(command.outputPath, commit);
      requireCondition(
        report.execution.aggregate_retry_count === 0 &&
          report.runtime.connection_generation_count === 2 &&
          report.cleanup.temporary_roots_remaining === 0,
        "Windows Codex vertical report is incomplete."
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  try {
    rmSync(root, { force: true, recursive: true });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Windows Codex vertical and harness cleanup failed."
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
  process.stdout.write(
    command.mode === "run"
      ? `Windows Codex vertical passed at ${commit.slice(0, 12)}.\n`
      : `Windows Codex vertical harness preflight passed at ${commit.slice(0, 12)}.\n`
  );
}

function readProducedReport(path, expectedCommit) {
  const metadata = lstatSync(path);
  requireCondition(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      metadata.size >= 2 &&
      metadata.size <= 64 * 1_024,
    "Windows Codex vertical report file is invalid."
  );
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Windows Codex vertical report is not valid JSON.");
  }
  requireCondition(
    report !== null &&
      typeof report === "object" &&
      !Array.isArray(report) &&
      report.schema_version === 1 &&
      report.task === "INT-V1-104" &&
      report.scenario === "exact_windows_structured_vertical" &&
      report.hostdeck_commit === expectedCommit &&
      report.runner?.target === "windows-x64" &&
      report.runner?.node_platform === "win32" &&
      report.runner?.architecture === "x64" &&
      report.runtime?.version === "0.144.0" &&
      report.runtime?.app_server_process_count === 2 &&
      report.runtime?.connection_generation_count === 2 &&
      report.runtime?.endpoint_rotation_count === 1 &&
      report.runtime?.credential_rotation_count === 1 &&
      report.execution?.aggregate_retry_count === 0 &&
      report.continuity?.completed_reconnects === 1 &&
      report.continuity?.boundary_count === 2 &&
      report.continuity?.ready_count === 2 &&
      report.privacy?.contains_path === false &&
      report.privacy?.contains_model_effort_prompt_goal_command_tui_or_auth ===
        false &&
      report.cleanup?.app_servers_remaining === 0 &&
      report.cleanup?.listeners_remaining === 0 &&
      report.cleanup?.credential_files_remaining === 0 &&
      report.cleanup?.temporary_roots_remaining === 0,
    "Windows Codex vertical report is incomplete."
  );
  return report;
}

function locateExactRuntime() {
  const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));
  const packagePath = requireFromRoot.resolve("@openai/codex/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  requireCondition(
    manifest?.name === "@openai/codex" && manifest.version === "0.144.0",
    "Exact Codex package is unavailable."
  );
  const requireFromCodex = createRequire(packagePath);
  const nativePackagePath = requireFromCodex.resolve(
    "@openai/codex-win32-x64/package.json"
  );
  const nativeRoot = realpathSync(dirname(nativePackagePath));
  const binRoot = join(
    nativeRoot,
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin"
  );
  const codexBin = realpathSync(join(binRoot, "codex.exe"));
  const codeModeHost = realpathSync(join(binRoot, "codex-code-mode-host.exe"));
  requireCondition(
    lstatSync(codexBin).isFile() &&
      lstatSync(codeModeHost).isFile() &&
      lstatSync(codeModeHost).size > 1_000_000 &&
      sha256File(codexBin) === exactWindowsCodexSha256,
    "Exact Codex Windows binary identity is invalid."
  );
  return Object.freeze({
    codexBin,
    codeModeHost,
    codeModeHostSha256: sha256File(codeModeHost)
  });
}

function requireAuthentication() {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  const metadata = lstatSync(authPath);
  requireCondition(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "Windows Codex vertical requires installed Codex authentication."
  );
}

function secureCurrentUserOnly(path, kind) {
  const result = nativeWindowsFileSecurityPort.secureCurrentUserOnly(path, kind);
  requireCondition(
    result.inspection.owner_current_user &&
      result.inspection.acl_current_user_only &&
      result.inspection.is_directory === (kind === "directory") &&
      !result.inspection.is_reparse_point &&
      !result.inspection.has_named_streams &&
      (kind === "directory" || result.inspection.link_count === 1),
    "Windows Codex vertical harness path security failed."
  );
}

function resolvePnpmInvocation() {
  const cli = realpathSync(
    join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js")
  );
  return Object.freeze({
    arguments: Object.freeze([cli]),
    command: realpathSync(process.execPath)
  });
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1_024,
    shell: false,
    timeout: 10_000,
    windowsHide: true
  });
  requireCondition(
    result.error === undefined && result.signal === null && result.status === 0,
    "Windows Codex vertical could not inspect source identity."
  );
  return result.stdout;
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--validate-harness") {
    return Object.freeze({ mode: "validate_harness" });
  }
  if (
    args.length === 2 &&
    args[0] === "--output" &&
    typeof args[1] === "string" &&
    isAbsolute(args[1])
  ) {
    return Object.freeze({ mode: "run", outputPath: resolve(args[1]) });
  }
  throw new Error(
    "Usage: node scripts/run-windows-codex-vertical.mjs <--validate-harness|--output <absolute-path>>"
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
