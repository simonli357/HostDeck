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
  assertLifecycleDirectoryEmpty,
  assertPrivateLifecycleDirectory,
  countCurrentUserProcessReferences,
  publishPrivateLifecycleJson,
  readPrivateLifecycleJson,
  requireLifecycleEvidencePath
} from "./codex-runtime-lifecycle-files.js";
import { runOwnedLifecycleScenario } from "./codex-runtime-lifecycle-process.js";
import {
  createSharedRuntimeHardeningEvidence,
  parseSharedRuntimeHardeningEvidence
} from "./shared-runtime-hardening.js";
import {
  createSharedRuntimeHardeningManifest,
  type SharedRuntimeHardeningManifestEntry
} from "./shared-runtime-hardening-manifest.js";

const requireHardening =
  process.env.HOSTDECK_REQUIRE_SHARED_RUNTIME_HARDENING === "1";
const defaultEvidencePath = resolve(
  "artifacts/int-v1-114-shared-runtime-hardening-evidence.json"
);
const requireFromHere = createRequire(import.meta.url);
const vitestEntry = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);

describe.skipIf(!requireHardening)("selected shared runtime hardening", () => {
  it(
    "binds the fixed hostile inventory and exact multi-project lifecycle to one clean commit",
    async () => {
      const repositoryRoot = realpathSync(process.cwd());
      const evidencePath = requireLifecycleEvidencePath(
        process.env.HOSTDECK_SHARED_RUNTIME_HARDENING_REPORT ??
          defaultEvidencePath,
        repositoryRoot
      );
      const evidenceExisted = existsSync(evidencePath);
      const codexBin = requireExactCodexBinary(
        process.env.HOSTDECK_CODEX_BIN
      );
      const commit = currentCleanCommit(repositoryRoot);
      const outerRoot = createPrivateOuterRoot();
      const manifest = createSharedRuntimeHardeningManifest({
        repository_root: repositoryRoot,
        outer_root: outerRoot,
        node_bin: realpathSync(process.execPath),
        vitest_entry: vitestEntry,
        codex_bin: codexBin,
        expected_commit: commit,
        base_env: process.env
      });
      let published = false;

      try {
        const reports: unknown[] = [];
        for (const entry of manifest) reports.push(await runScenario(entry));
        assertLifecycleDirectoryEmpty(outerRoot);
        expect(countCurrentUserProcessReferences(outerRoot)).toBe(0);
        rmdirSync(outerRoot);
        expect(existsSync(outerRoot)).toBe(false);

        const evidence = createSharedRuntimeHardeningEvidence({
          observed_at: new Date().toISOString(),
          hostdeck_commit: commit,
          repository_root: repositoryRoot,
          deterministic_report: reports[0],
          real_report: reports[1],
          cleanup: zeroCleanup()
        });
        assertFinalPrivacy(evidence, [
          repositoryRoot,
          outerRoot,
          codexBin,
          evidencePath
        ]);
        const written = publishPrivateLifecycleJson(evidencePath, evidence);
        expect(parseSharedRuntimeHardeningEvidence(written)).toEqual(evidence);
        expect(
          parseSharedRuntimeHardeningEvidence(
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
                "Shared runtime hardening cleanup found an owned process."
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
            "Shared runtime hardening and cleanup failed."
          );
        }
        throw error;
      }
    },
    400_000
  );
});

async function runScenario(
  entry: SharedRuntimeHardeningManifestEntry
): Promise<unknown> {
  mkdirSync(entry.root, { mode: 0o700 });
  chmodSync(entry.root, 0o700);
  assertPrivateLifecycleDirectory(entry.root);
  if (existsSync(entry.report_path)) {
    throw new TypeError("Shared runtime scenario report already exists.");
  }
  if (entry.precreate_report) {
    writeFileSync(entry.report_path, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  await runOwnedLifecycleScenario(entry.command);
  assertScenarioInventory(entry);
  const report = readPrivateLifecycleJson(entry.report_path);
  rmSync(entry.report_path);
  rmdirSync(entry.root);
  return report;
}

function assertScenarioInventory(
  entry: SharedRuntimeHardeningManifestEntry
): void {
  assertPrivateLifecycleDirectory(entry.root);
  const entries = readdirSync(entry.root, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== entry.report_name ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new TypeError("Shared runtime scenario inventory is invalid.");
  }
  const metadata = lstatSync(entry.report_path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > 1024 * 1024 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("Shared runtime scenario report is insecure.");
  }
  JSON.parse(readFileSync(entry.report_path, "utf8"));
}

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError(
      "Shared runtime hardening requires an absolute Codex binary."
    );
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError("Shared runtime hardening Codex binary is unavailable.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1
  ) {
    throw new TypeError("Shared runtime hardening Codex binary is insecure.");
  }
  const version = parseCodexCliVersionOutput(
    execFileSync(path, ["--version"], {
      cwd: "/",
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024
    })
  );
  if (version !== codexBindingDescriptor.codex_version) {
    throw new TypeError("Shared runtime hardening Codex version is unsupported.");
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
      maxBuffer: 256 * 1024
    }
  ).trim();
  if (status !== "") {
    throw new Error("Shared runtime hardening requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Shared runtime hardening commit is invalid.");
  }
  return commit;
}

function createPrivateOuterRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hd-srh-"));
  try {
    chmodSync(root, 0o700);
    assertPrivateLifecycleDirectory(root);
    if (Buffer.byteLength(root, "utf8") > 36) {
      throw new TypeError(
        "Shared runtime hardening root is too long for nested Unix sockets."
      );
    }
    return root;
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function assertFinalPrivacy(
  evidence: unknown,
  sensitiveValues: readonly string[]
): void {
  const encoded = JSON.stringify(evidence);
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0 && encoded.includes(sensitive)) {
      throw new TypeError("Shared runtime hardening evidence contains private data.");
    }
  }
}

function zeroCleanup() {
  return {
    app_servers_remaining: 0,
    browser_processes_remaining: 0,
    temporary_roots_remaining: 0,
    tmux_servers_remaining: 0,
    tui_processes_remaining: 0,
    unix_sockets_remaining: 0
  };
}
