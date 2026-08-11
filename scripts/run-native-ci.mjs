import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeCiTargetPolicies,
  writeNativeCiEvidence
} from "./native-ci-evidence.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const pnpmInvocation = resolvePnpmInvocation();
const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "gu"
);
const allowedEnvironmentKeys = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "COREPACK_HOME",
  "GITHUB_ACTIONS",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "PROGRAMDATA",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME"
]);

async function main() {
  const { output, target } = parseArguments(process.argv.slice(2));
  const policy = nativeCiTargetPolicies[target];
  requireCondition(realpathSync(process.cwd()) === repositoryRoot, "Native CI must run from the repository root.");
  requireCondition(
    process.platform === policy.node_platform && process.arch === policy.architecture,
    "Native CI target does not match the current host."
  );
  requireCondition(
    process.env.HOSTDECK_NATIVE_RUNNER_LABEL === policy.runner_label,
    "Native CI runner label does not match the target."
  );
  const runnerTemp = requiredAbsoluteDirectory(process.env.RUNNER_TEMP, "RUNNER_TEMP");
  const outputPath = resolve(output);
  const outputRelative = relative(runnerTemp, outputPath);
  requireCondition(
    outputRelative !== "" &&
      !outputRelative.startsWith("..") &&
      !isAbsolute(outputRelative),
    "Native CI output must stay inside RUNNER_TEMP."
  );
  requireCondition(process.versions.node === "22.22.2", "Native CI Node version is invalid.");
  requireCondition(process.versions.modules === "127", "Native CI Node ABI is invalid.");
  requireCondition(process.versions.napi === "10", "Native CI N-API version is invalid.");
  const pnpmVersion = readPnpmVersion();
  requireCondition(pnpmVersion === "10.29.2", "Native CI pnpm version is invalid.");

  const reportRoot = mkdtempSync(join(runnerTemp, "hostdeck-native-ci-reports-"));
  const checks = [];
  let nativeDependencies;
  try {
    runPnpmCheck(checks, "scaffold", ["check:scaffold"]);
    runPnpmCheck(checks, "planning", ["check:planning"]);
    runPnpmCheck(checks, "runtime_boundary", ["check:runtime-boundary"]);
    runPnpmCheck(checks, "typecheck", ["typecheck"]);
    runPnpmCheck(checks, "lint", ["lint"]);
    runVitestCheck(checks, "contract", ["--config", "vitest.contract.config.ts"], reportRoot);
    runVitestCheck(
      checks,
      "native_lock",
      ["packages/storage/src/platform-file-lock.test.ts"],
      reportRoot
    );
    runVitestCheck(
      checks,
      "windows_paths",
      ["packages/storage/src/windows-secure-local-path-adapter.native.test.ts"],
      reportRoot
    );
    if (target === "linux-x64") {
      runVitestCheck(
        checks,
        "integration",
        ["--config", "vitest.integration.config.ts"],
        reportRoot
      );
    }
    runPnpmCheck(checks, "web_build", ["--filter", "@hostdeck/web", "build"]);
    nativeDependencies = runTimedCheck(checks, "native_modules", probeNativeModules);
    if (target === "linux-x64") {
      runPnpmCheck(checks, "package", ["test:package"], 10 * 60_000);
    }
  } finally {
    rmSync(reportRoot, { force: true, recursive: true });
  }
  requireCondition(
    checks.length === policy.checks.length &&
      checks.every((check, index) => check.id === policy.checks[index]),
    "Native CI check coverage is incomplete."
  );

  writeNativeCiEvidence(outputPath, {
    target,
    generated_at: new Date().toISOString(),
    workflow: {
      event: requiredEnvironment("GITHUB_EVENT_NAME"),
      name: "native-ci",
      run_attempt: parsePositiveInteger(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
      run_id: requiredEnvironment("GITHUB_RUN_ID")
    },
    source: {
      commit: requiredEnvironment("GITHUB_SHA"),
      lockfile_sha256: sha256File(join(repositoryRoot, "pnpm-lock.yaml"))
    },
    runner: {
      architecture: process.arch,
      image_version: requiredEnvironment("ImageVersion"),
      label: policy.runner_label,
      node_platform: process.platform,
      os_release: osRelease()
    },
    toolchain: {
      node_module_abi: process.versions.modules,
      node_napi: process.versions.napi,
      node_version: process.versions.node,
      pnpm_version: pnpmVersion
    },
    native_dependencies: nativeDependencies,
    checks
  });
  process.stdout.write(`HostDeck native CI passed: ${target}, ${checks.length} checks.\n`);
}

function runPnpmCheck(checks, id, args, timeout = 5 * 60_000) {
  runTimedCheck(checks, id, () => {
    runCommand(
      pnpmInvocation.command,
      [...pnpmInvocation.arguments, ...args],
      timeout,
      id
    );
  });
}

function runVitestCheck(checks, id, args, reportRoot) {
  runTimedCheck(checks, id, () => {
    const reportPath = join(reportRoot, `${id}.json`);
    const commandResult = runCommand(
      pnpmInvocation.command,
      [
        ...pnpmInvocation.arguments,
        "exec",
        "vitest",
        "run",
        ...args,
        "--reporter=json",
        `--outputFile=${reportPath}`
      ],
      5 * 60_000,
      id,
      { deferFailure: true }
    );
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
    const reportPassed =
      report !== null &&
        typeof report === "object" &&
        report.success === true &&
        Number.isSafeInteger(report.numTotalTests) &&
        report.numTotalTests > 0 &&
        report.numPassedTests === report.numTotalTests &&
        report.numFailedTests === 0 &&
        report.numPendingTests === 0 &&
        report.numTodoTests === 0 &&
        Array.isArray(report.testResults) &&
        report.testResults.length > 0;
    if (!commandResult.passed || !reportPassed) {
      const summary = vitestFailureSummary(report);
      if (summary !== "") process.stderr.write(`${summary}\n`);
      throw new Error(`Native CI ${id} report contains a failure or unsupported skip.`);
    }
  });
}

function runTimedCheck(checks, id, work) {
  const started = performance.now();
  const result = work();
  const duration = Math.max(0, Math.round(performance.now() - started));
  checks.push(Object.freeze({ duration_ms: duration, id, status: "passed" }));
  process.stdout.write(`native-ci ${id}: passed (${duration}ms)\n`);
  return result;
}

function runCommand(command, args, timeout, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: commandEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout,
    windowsHide: true
  });
  const passed =
    result.error === undefined && result.status === 0 && result.signal === null;
  if (!passed && options.deferFailure !== true) {
    const diagnostic = sanitizeDiagnostic(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
    if (diagnostic !== "") process.stderr.write(`${diagnostic}\n`);
    throw new Error(`Native CI ${label} command failed.`);
  }
  return Object.freeze({ passed });
}

function vitestFailureSummary(report) {
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) {
    return "Vitest did not produce a readable structured report.";
  }
  const failures = [];
  for (const result of report.testResults) {
    if (result === null || typeof result !== "object" || result.status !== "failed") continue;
    const assertions = Array.isArray(result.assertionResults)
      ? result.assertionResults.filter((assertion) => assertion?.status === "failed")
      : [];
    if (assertions.length === 0) {
      failures.push(
        `${basename(String(result.name ?? "unknown-suite"))}: ${String(
          result.message ?? "suite failed before assertions"
        )}`
      );
    } else {
      for (const assertion of assertions) {
        const failureMessages = Array.isArray(assertion.failureMessages)
          ? assertion.failureMessages
              .filter((message) => typeof message === "string" && message.trim() !== "")
              .slice(0, 2)
          : [];
        failures.push(
          [
            `${basename(String(result.name ?? "unknown-suite"))}: ${String(
              assertion.fullName ?? assertion.title ?? "failed assertion"
            )}`,
            ...failureMessages
          ].join("\n")
        );
      }
    }
    if (failures.length >= 8) break;
  }
  return sanitizeDiagnostic(failures.slice(0, 8).join("\n"));
}

function commandEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedEnvironmentKeys.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return { ...env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", TZ: "UTC" };
}

function probeNativeModules() {
  const requireFromStorage = createRequire(join(repositoryRoot, "packages", "storage", "package.json"));
  const sqlitePackage = requireFromStorage("better-sqlite3/package.json");
  const lockPackage = requireFromStorage("fs-native-extensions/package.json");
  const koffiPackage = JSON.parse(
    readFileSync(join(dirname(requireFromStorage.resolve("koffi")), "package.json"), "utf8")
  );
  requireCondition(sqlitePackage.version === "12.11.1", "Native SQLite version is invalid.");
  requireCondition(lockPackage.version === "1.3.4", "Native file-lock version is invalid.");
  requireCondition(koffiPackage.version === "3.1.4", "Native Windows FFI version is invalid.");
  const Database = requireFromStorage("better-sqlite3");
  const nativeLock = requireFromStorage("fs-native-extensions");
  const koffi = requireFromStorage("koffi");
  requireCondition(
    koffi.version === "3.1.4" && koffi.sizeof("uint32_t") === 4,
    "Native Windows FFI probe failed."
  );
  const database = new Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "hostdeck-native-ci-probe-"));
  const lockPath = join(root, "native.lock");
  writeFileSync(lockPath, "", { mode: 0o600 });
  const first = openSync(lockPath, "r+");
  const second = openSync(lockPath, "r+");
  let firstHeld = false;
  let secondHeld = false;
  try {
    requireCondition(
      database.prepare("SELECT 1 AS value").get()?.value === 1,
      "Native SQLite probe failed."
    );
    firstHeld = nativeLock.tryLock(first);
    requireCondition(firstHeld === true, "Native file lock was not acquired.");
    requireCondition(nativeLock.tryLock(second) === false, "Native file lock allowed contention.");
    nativeLock.unlock(first);
    firstHeld = false;
    secondHeld = nativeLock.tryLock(second);
    requireCondition(secondHeld === true, "Native file lock was not recoverable.");
  } finally {
    if (secondHeld) nativeLock.unlock(second);
    if (firstHeld) nativeLock.unlock(first);
    closeSync(second);
    closeSync(first);
    database.close();
    rmSync(root, { force: true, recursive: true });
  }
  return Object.freeze([
    Object.freeze({ name: "better-sqlite3", version: sqlitePackage.version }),
    Object.freeze({ name: "fs-native-extensions", version: lockPackage.version }),
    Object.freeze({ name: "koffi", version: koffiPackage.version })
  ]);
}

function readPnpmVersion() {
  const result = spawnSync(
    pnpmInvocation.command,
    [...pnpmInvocation.arguments, "--version"],
    {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: commandEnvironment(),
    maxBuffer: 1_024,
    shell: false,
    timeout: 10_000,
    windowsHide: true
    }
  );
  requireCondition(
    result.error === undefined &&
      result.status === 0 &&
      result.signal === null &&
      result.stderr === "" &&
      /^10\.29\.2\r?\n$/u.test(result.stdout),
    "Native CI could not verify pnpm."
  );
  return result.stdout.trim();
}

function resolvePnpmInvocation() {
  if (process.platform !== "win32") {
    return Object.freeze({ arguments: Object.freeze([]), command: "pnpm" });
  }
  const cli = realpathSync(
    join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js")
  );
  return Object.freeze({
    arguments: Object.freeze([cli]),
    command: realpathSync(process.execPath)
  });
}

function parseArguments(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--target" ||
    !Object.hasOwn(nativeCiTargetPolicies, args[1]) ||
    args[2] !== "--output" ||
    typeof args[3] !== "string" ||
    !isAbsolute(args[3])
  ) {
    throw new TypeError(
      "Usage: node scripts/run-native-ci.mjs --target <linux-x64|windows-x64> --output <absolute-path>"
    );
  }
  return Object.freeze({ output: args[3], target: args[1] });
}

function requiredAbsoluteDirectory(candidate, label) {
  requireCondition(
    typeof candidate === "string" && candidate.length <= 1_024 && isAbsolute(candidate),
    `${label} is invalid.`
  );
  return realpathSync(candidate);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  requireCondition(
    typeof value === "string" && value.length >= 1 && value.length <= 128,
    `Native CI environment ${name} is invalid.`
  );
  return value;
}

function parsePositiveInteger(candidate) {
  requireCondition(/^[1-9][0-9]{0,3}$/u.test(candidate), "Native CI integer is invalid.");
  return Number(candidate);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitizeDiagnostic(candidate) {
  let value = String(candidate).replaceAll(ansiEscapePattern, "");
  for (const privatePath of [repositoryRoot, process.env.HOME, process.env.USERPROFILE, process.env.RUNNER_TEMP]) {
    if (typeof privatePath === "string" && privatePath !== "") {
      value = value.split(privatePath).join("<path>");
    }
  }
  value = value
    .replaceAll(/https?:\/\/\S+/gu, "<url>")
    .replaceAll(
      /(authorization|password|secret|token)\s*[:=]\s*\S+/giu,
      "$1=<redacted>"
    )
    .trim();
  return value.length <= 16_384 ? value : value.slice(-16_384);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  process.stderr.write(
    `${sanitizeDiagnostic(error instanceof Error ? error.message : "Native CI failed.")}\n`
  );
  process.exitCode = 1;
});
