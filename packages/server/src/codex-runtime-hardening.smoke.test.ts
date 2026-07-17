import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  codexBindingDescriptor,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import { describe, expect, it } from "vitest";
import {
  createRuntimeHardeningEvidence,
  parseRuntimeHardeningEvidence
} from "./codex-runtime-hardening.js";
import {
  createRuntimeHardeningScenarioManifest,
  type RuntimeHardeningManifestEntry,
  type RuntimeHardeningScenarioName,
  runRuntimeHardeningScenarioManifest
} from "./codex-runtime-hardening-manifest.js";
import {
  createRuntimeLifecycleAcceptanceEvidence,
  type RuntimeLifecycleAcceptanceEvidence
} from "./codex-runtime-lifecycle-acceptance.js";
import {
  assertLifecycleDirectoryEmpty,
  assertLifecycleScenarioInventory,
  assertPrivateLifecycleDirectory,
  countCurrentUserProcessReferences,
  type LifecycleScenarioReportName,
  lifecycleScenarioReportNames,
  publishPrivateLifecycleJson,
  readPrivateLifecycleJson,
  requireLifecycleEvidencePath,
  requirePrivateLifecycleReportPath
} from "./codex-runtime-lifecycle-files.js";
import { runOwnedLifecycleScenario } from "./codex-runtime-lifecycle-process.js";
import {
  readStructuredVerticalReport,
  requireStructuredVerticalReportPath
} from "./codex-structured-vertical-report.js";

const requireHardening =
  process.env.HOSTDECK_REQUIRE_CODEX_HARDENING === "1";
const defaultEvidencePath = resolve(
  "artifacts/int-v1-091-selected-runtime-hardening-evidence.json"
);
const requireFromHere = createRequire(import.meta.url);
const vitestEntry = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);

describe.skipIf(!requireHardening)("selected Codex runtime hardening", () => {
  it(
    "proves the fixed deterministic, structured-control, and lifecycle aggregate",
    async () => {
      const repositoryRoot = realpathSync(process.cwd());
      const evidencePath = requireLifecycleEvidencePath(
        process.env.HOSTDECK_CODEX_HARDENING_REPORT ?? defaultEvidencePath,
        repositoryRoot
      );
      const evidenceExisted = existsSync(evidencePath);
      const codexBin = requireExactCodexBinary(process.env.HOSTDECK_CODEX_BIN);
      const commit = currentCleanCommit(repositoryRoot);
      const outerRoot = createPrivateOuterRoot();
      const manifest = createRuntimeHardeningScenarioManifest({
        repository_root: repositoryRoot,
        outer_root: outerRoot,
        node_bin: realpathSync(process.execPath),
        vitest_entry: vitestEntry,
        codex_bin: codexBin,
        base_env: process.env
      });
      let published = false;

      try {
        const reports = await runRuntimeHardeningScenarioManifest(
          manifest,
          async (entry) => runScenario(entry, commit)
        );
        assertLifecycleDirectoryEmpty(outerRoot);
        expect(countCurrentUserProcessReferences(outerRoot)).toBe(0);
        rmdirSync(outerRoot);
        expect(existsSync(outerRoot)).toBe(false);
        const lifecycleEvidence = createLifecycleEvidence(
          reports,
          commit,
          repositoryRoot
        );

        const evidence = createRuntimeHardeningEvidence({
          observed_at: new Date().toISOString(),
          hostdeck_commit: commit,
          repository_root: repositoryRoot,
          deterministic_report: requireReport(
            reports,
            "deterministic_runtime"
          ),
          structured_vertical_report: requireReport(
            reports,
            "exact_structured_vertical"
          ),
          lifecycle_evidence: lifecycleEvidence,
          outer_cleanup: {
            process_groups_remaining: 0,
            special_files_remaining: 0,
            temporary_roots_remaining: 0,
            child_reports_remaining: 0
          }
        });
        assertFinalPrivacy(evidence, [
          repositoryRoot,
          outerRoot,
          codexBin,
          evidencePath
        ]);
        const written = publishPrivateLifecycleJson(evidencePath, evidence);
        expect(parseRuntimeHardeningEvidence(written)).toEqual(evidence);
        expect(
          parseRuntimeHardeningEvidence(readPrivateLifecycleJson(evidencePath))
        ).toEqual(evidence);
        published = true;
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (existsSync(outerRoot)) {
          try {
            const references = countCurrentUserProcessReferences(outerRoot);
            if (references !== 0) {
              throw new Error(
                "Runtime hardening failure cleanup found a process using its private root."
              );
            }
            rmSync(outerRoot, { force: true, recursive: true });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (!evidenceExisted && !published) {
          try {
            rmSync(evidencePath, { force: true });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Runtime hardening aggregate and cleanup failed."
          );
        }
        throw error;
      }
    },
    1_250_000
  );
});

async function runScenario(
  entry: RuntimeHardeningManifestEntry,
  expectedCommit: string
): Promise<{
  readonly name: RuntimeHardeningScenarioName;
  readonly report: unknown;
}> {
  mkdirSync(entry.root, { mode: 0o700 });
  chmodSync(entry.root, 0o700);
  if (entry.lifecycle_entry) {
    requirePrivateLifecycleReportPath(
      entry.report_path,
      requireLifecycleReportName(entry.report_name),
      entry.root
    );
  } else if (entry.name === "exact_structured_vertical") {
    requireStructuredVerticalReportPath(entry.report_path, entry.root);
  } else {
    requireHardeningReportPath(
      entry.report_path,
      "deterministic-report.json",
      entry.root
    );
  }
  if (entry.precreate_report) {
    writeFileSync(entry.report_path, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }

  await runOwnedLifecycleScenario(entry.command);
  let report: unknown;
  if (entry.lifecycle_entry) {
    assertLifecycleScenarioInventory(entry.root, [
      requireLifecycleReportName(entry.report_name)
    ]);
    report = readPrivateLifecycleJson(entry.report_path);
  } else {
    assertHardeningScenarioInventory(entry.root, entry.report_name);
    report =
      entry.name === "exact_structured_vertical"
        ? readStructuredVerticalReport(entry.report_path, expectedCommit)
        : readPrivateHardeningJson(entry.report_path);
  }
  rmSync(entry.report_path);
  rmdirSync(entry.root);
  return Object.freeze({ name: entry.name, report });
}

function createLifecycleEvidence(
  reports: readonly {
    readonly name: RuntimeHardeningScenarioName;
    readonly report: unknown;
  }[],
  commit: string,
  repositoryRoot: string
): RuntimeLifecycleAcceptanceEvidence {
  return createRuntimeLifecycleAcceptanceEvidence({
    observed_at: new Date().toISOString(),
    hostdeck_commit: commit,
    repository_root: repositoryRoot,
    vitest_report: requireReport(reports, "headless_reconnect_crash"),
    supervisor_report: requireReport(reports, "exact_supervisor"),
    restart_report: requireReport(reports, "exact_hostdeck_restart"),
    coexistence_report: requireReport(reports, "exact_tui_coexistence"),
    outer_cleanup: {
      process_groups_remaining: 0,
      special_files_remaining: 0,
      temporary_roots_remaining: 0,
      child_reports_remaining: 0
    }
  });
}

function requireReport(
  reports: readonly {
    readonly name: RuntimeHardeningScenarioName;
    readonly report: unknown;
  }[],
  name: RuntimeHardeningScenarioName
): unknown {
  const matches = reports.filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    throw new TypeError("Runtime hardening scenario report is missing.");
  }
  return matches[0]?.report;
}

function requireLifecycleReportName(
  candidate: string
): LifecycleScenarioReportName {
  if (
    !lifecycleScenarioReportNames.includes(
      candidate as LifecycleScenarioReportName
    )
  ) {
    throw new TypeError("Runtime hardening lifecycle report name is invalid.");
  }
  return candidate as LifecycleScenarioReportName;
}

function requireHardeningReportPath(
  candidate: string,
  expectedName: string,
  expectedRoot: string
): void {
  if (
    !isAbsolute(candidate) ||
    resolve(dirname(candidate)) !== resolve(expectedRoot) ||
    candidate !== join(resolve(expectedRoot), expectedName) ||
    existsSync(candidate)
  ) {
    throw new TypeError("Runtime hardening report path is invalid.");
  }
  assertPrivateLifecycleDirectory(expectedRoot);
}

function assertHardeningScenarioInventory(
  root: string,
  expectedName: string
): void {
  assertPrivateLifecycleDirectory(root);
  const entries = readdirSync(root, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== expectedName ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new TypeError("Runtime hardening scenario inventory is invalid.");
  }
  assertPrivateHardeningJsonFile(join(root, expectedName));
}

function readPrivateHardeningJson(path: string): unknown {
  assertPrivateHardeningJsonFile(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError("Runtime hardening report is not valid JSON.", {
      cause: error
    });
  }
}

function assertPrivateHardeningJsonFile(path: string): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > 1024 * 1_024 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("Runtime hardening report is insecure or invalid.");
  }
}

function assertFinalPrivacy(
  evidence: unknown,
  sensitiveValues: readonly string[]
): void {
  const encoded = JSON.stringify(evidence);
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0 && encoded.includes(sensitive)) {
      throw new TypeError("Runtime hardening evidence contains a private value.");
    }
  }
}

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError("Runtime hardening requires an absolute Codex binary.");
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError("Runtime hardening Codex binary is unavailable.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1
  ) {
    throw new TypeError("Runtime hardening Codex binary is insecure.");
  }
  const version = parseCodexCliVersionOutput(
    execFileSync(path, ["--version"], {
      cwd: "/",
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1_024
    })
  );
  if (version !== codexBindingDescriptor.codex_version) {
    throw new TypeError("Runtime hardening Codex version is unsupported.");
  }
  return path;
}

function createPrivateOuterRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hd-rh-"));
  try {
    chmodSync(root, 0o700);
    assertPrivateLifecycleDirectory(root);
    if (Buffer.byteLength(root, "utf8") > 32) {
      throw new TypeError(
        "Runtime hardening temporary root is too long for nested Unix sockets."
      );
    }
    return root;
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function currentCleanCommit(repositoryRoot: string): string {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1_024
    }
  ).trim();
  if (status !== "") {
    throw new Error("Runtime hardening requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Runtime hardening commit is invalid.");
  }
  return commit;
}
