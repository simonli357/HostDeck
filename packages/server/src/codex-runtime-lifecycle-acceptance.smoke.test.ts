import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  createRuntimeLifecycleAcceptanceEvidence,
  parseRuntimeLifecycleAcceptanceEvidence
} from "./codex-runtime-lifecycle-acceptance.js";
import {
  assertLifecycleDirectoryEmpty,
  assertLifecycleScenarioInventory,
  assertPrivateLifecycleDirectory,
  countCurrentUserProcessReferences,
  publishPrivateLifecycleJson,
  readPrivateLifecycleJson,
  requireLifecycleEvidencePath,
  requirePrivateLifecycleReportPath
} from "./codex-runtime-lifecycle-files.js";
import {
  createLifecycleScenarioManifest,
  type LifecycleScenarioName,
  runLifecycleScenarioManifest
} from "./codex-runtime-lifecycle-manifest.js";
import { runOwnedLifecycleScenario } from "./codex-runtime-lifecycle-process.js";

const requireAcceptance =
  process.env.HOSTDECK_REQUIRE_CODEX_LIFECYCLE_ACCEPTANCE === "1";
const defaultEvidencePath = resolve(
  "artifacts/int-v1-032-runtime-lifecycle-acceptance-evidence.json"
);
const requireFromHere = createRequire(import.meta.url);
const vitestEntry = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);

describe.skipIf(!requireAcceptance)(
  "selected runtime lifecycle acceptance",
  () => {
    it(
      "proves the fixed deterministic and exact lifecycle matrix with complete cleanup",
      async () => {
        const repositoryRoot = realpathSync(process.cwd());
        const evidencePath = requireLifecycleEvidencePath(
          process.env.HOSTDECK_CODEX_LIFECYCLE_REPORT ?? defaultEvidencePath,
          repositoryRoot
        );
        const evidenceExisted = existsSync(evidencePath);
        const codexBin = requireExactCodexBinary(
          process.env.HOSTDECK_CODEX_BIN
        );
        const commit = currentCleanCommit(repositoryRoot);
        const outerRoot = mkdtempSync(
          join(tmpdir(), "hostdeck-runtime-lifecycle-acceptance-")
        );
        chmodSync(outerRoot, 0o700);
        assertPrivateLifecycleDirectory(outerRoot);
        const manifest = createLifecycleScenarioManifest({
          repository_root: repositoryRoot,
          outer_root: outerRoot,
          node_bin: realpathSync(process.execPath),
          vitest_entry: vitestEntry,
          codex_bin: codexBin,
          base_env: process.env
        });
        let published = false;

        try {
          const reports = await runLifecycleScenarioManifest(
            manifest,
            async (entry) => {
              mkdirSync(entry.root, { mode: 0o700 });
              chmodSync(entry.root, 0o700);
              requirePrivateLifecycleReportPath(
                entry.report_path,
                entry.report_name,
                entry.root
              );
              if (entry.precreate_report) {
                writeFileSync(entry.report_path, "", {
                  encoding: "utf8",
                  flag: "wx",
                  mode: 0o600
                });
              }
              await runOwnedLifecycleScenario(entry.command);
              assertLifecycleScenarioInventory(entry.root, [entry.report_name]);
              const report = readPrivateLifecycleJson(entry.report_path);
              rmSync(entry.report_path);
              rmdirSync(entry.root);
              return Object.freeze({ name: entry.name, report });
            }
          );

          assertLifecycleDirectoryEmpty(outerRoot);
          expect(countCurrentUserProcessReferences(outerRoot)).toBe(0);
          rmdirSync(outerRoot);
          expect(existsSync(outerRoot)).toBe(false);

          const evidence = createRuntimeLifecycleAcceptanceEvidence({
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
          const written = publishPrivateLifecycleJson(evidencePath, evidence);
          expect(parseRuntimeLifecycleAcceptanceEvidence(written)).toEqual(
            evidence
          );
          expect(
            parseRuntimeLifecycleAcceptanceEvidence(
              readPrivateLifecycleJson(evidencePath)
            )
          ).toEqual(evidence);
          published = true;
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          if (existsSync(outerRoot)) {
            try {
              const references = countCurrentUserProcessReferences(outerRoot);
              if (references !== 0) {
                throw new Error(
                  "Lifecycle failure cleanup found a process using its private root."
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
              "Runtime lifecycle acceptance and cleanup failed."
            );
          }
          throw error;
        }
      },
      700_000
    );
  }
);

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError("Lifecycle acceptance requires an absolute Codex binary.");
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError("Lifecycle acceptance Codex binary is unavailable.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1
  ) {
    throw new TypeError("Lifecycle acceptance Codex binary is insecure.");
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
    throw new TypeError("Lifecycle acceptance Codex version is unsupported.");
  }
  return path;
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
    throw new Error("Lifecycle acceptance requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Lifecycle acceptance commit is invalid.");
  }
  return commit;
}

function requireReport(
  reports: readonly {
    readonly name: LifecycleScenarioName;
    readonly report: unknown;
  }[],
  name: LifecycleScenarioName
): unknown {
  const matches = reports.filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    throw new TypeError("Lifecycle acceptance scenario report is missing.");
  }
  return matches[0]?.report;
}
