import { join, resolve } from "node:path";
import {
  createLifecycleScenarioManifest,
  type LifecycleScenarioManifestEntry
} from "./codex-runtime-lifecycle-manifest.js";
import type { OwnedLifecycleScenarioCommand } from "./codex-runtime-lifecycle-process.js";
import { structuredVerticalReportName } from "./codex-structured-vertical-report.js";

export const runtimeHardeningDeterministicTests = Object.freeze([
  "packages/codex-adapter/src/approval-client.test.ts",
  "packages/codex-adapter/src/binding.test.ts",
  "packages/codex-adapter/src/broker.test.ts",
  "packages/codex-adapter/src/codex-operation-semantics-evidence.test.ts",
  "packages/codex-adapter/src/codex-operation-semantics-recorder.test.ts",
  "packages/codex-adapter/src/compact-client.test.ts",
  "packages/codex-adapter/src/compatibility.test.ts",
  "packages/codex-adapter/src/connection.test.ts",
  "packages/codex-adapter/src/event-normalizer.test.ts",
  "packages/codex-adapter/src/goal-client.test.ts",
  "packages/codex-adapter/src/model-client.test.ts",
  "packages/codex-adapter/src/plan-client.test.ts",
  "packages/codex-adapter/src/protocol.test.ts",
  "packages/codex-adapter/src/reconciliation-client.test.ts",
  "packages/codex-adapter/src/reconnect-controller.test.ts",
  "packages/codex-adapter/src/request-deadline.test.ts",
  "packages/codex-adapter/src/resource-options.test.ts",
  "packages/codex-adapter/src/skills-client.test.ts",
  "packages/codex-adapter/src/thread-client.test.ts",
  "packages/codex-adapter/src/transport.test.ts",
  "packages/codex-adapter/src/tui-resume.test.ts",
  "packages/codex-adapter/src/turn-client.test.ts",
  "packages/codex-adapter/src/usage-client.test.ts",
  "packages/server/src/codex-approval-control-service.test.ts",
  "packages/server/src/codex-compact-control-service.test.ts",
  "packages/server/src/codex-control-event-observer.test.ts",
  "packages/server/src/codex-event-pipeline.test.ts",
  "packages/server/src/codex-goal-control-service.test.ts",
  "packages/server/src/codex-hostdeck-restart-smoke-support.test.ts",
  "packages/server/src/codex-interrupt-control-service.test.ts",
  "packages/server/src/codex-model-control-service.test.ts",
  "packages/server/src/codex-plan-control-service.test.ts",
  "packages/server/src/codex-projection-service.test.ts",
  "packages/server/src/codex-prompt-control-service.test.ts",
  "packages/server/src/codex-request-deadline-aggregate.test.ts",
  "packages/server/src/codex-request-deadline-coverage.test.ts",
  "packages/server/src/codex-runtime-hardening-manifest.test.ts",
  "packages/server/src/codex-runtime-hardening.test.ts",
  "packages/server/src/codex-runtime-lifecycle-acceptance.failure.test.ts",
  "packages/server/src/codex-runtime-lifecycle-acceptance.test.ts",
  "packages/server/src/codex-runtime-lifecycle-files.test.ts",
  "packages/server/src/codex-runtime-lifecycle-manifest.test.ts",
  "packages/server/src/codex-runtime-lifecycle-process.test.ts",
  "packages/server/src/codex-runtime-reconciliation-lifecycle.test.ts",
  "packages/server/src/codex-runtime-supervisor.test.ts",
  "packages/server/src/codex-skills-control-service.test.ts",
  "packages/server/src/codex-structured-vertical-evidence.test.ts",
  "packages/server/src/codex-structured-vertical-report.test.ts",
  "packages/server/src/codex-structured-vertical-selection.test.ts",
  "packages/server/src/codex-usage-control-service.test.ts",
  "packages/server/src/managed-thread-service.test.ts",
  "packages/server/src/pending-turn-settings.test.ts"
] as const);

export const runtimeHardeningScenarioNames = Object.freeze([
  "deterministic_runtime",
  "exact_structured_vertical",
  "headless_reconnect_crash",
  "exact_supervisor",
  "exact_hostdeck_restart",
  "exact_tui_coexistence"
] as const);

export type RuntimeHardeningScenarioName =
  (typeof runtimeHardeningScenarioNames)[number];

export interface RuntimeHardeningManifestInput {
  readonly repository_root: string;
  readonly outer_root: string;
  readonly node_bin: string;
  readonly vitest_entry: string;
  readonly codex_bin: string;
  readonly base_env: NodeJS.ProcessEnv;
}

export interface RuntimeHardeningManifestEntry {
  readonly name: RuntimeHardeningScenarioName;
  readonly root: string;
  readonly report_name: string;
  readonly report_path: string;
  readonly precreate_report: boolean;
  readonly lifecycle_entry: boolean;
  readonly command: OwnedLifecycleScenarioCommand;
}

export function createRuntimeHardeningScenarioManifest(
  input: RuntimeHardeningManifestInput
): readonly RuntimeHardeningManifestEntry[] {
  const repositoryRoot = resolve(input.repository_root);
  const deterministicRoot = join(input.outer_root, "d0");
  const verticalRoot = join(input.outer_root, "v0");
  const baseEnvironment = sanitizedEnvironment(input.base_env);
  const lifecycle = createLifecycleScenarioManifest({
    ...input,
    repository_root: repositoryRoot,
    base_env: baseEnvironment
  });

  return Object.freeze([
    entry({
      name: "deterministic_runtime",
      root: deterministicRoot,
      report_name: "deterministic-report.json",
      precreate_report: true,
      lifecycle_entry: false,
      executable: input.node_bin,
      args: [
        input.vitest_entry,
        "run",
        "--config",
        join(repositoryRoot, "vitest.codex.config.ts"),
        "--reporter=json",
        `--outputFile=${join(deterministicRoot, "deterministic-report.json")}`,
        "--pool=threads",
        "--maxWorkers=2"
      ],
      cwd: repositoryRoot,
      env: scenarioEnvironment(baseEnvironment, deterministicRoot, {}),
      timeout_ms: 180_000,
      max_output_bytes: 512 * 1_024
    }),
    entry({
      name: "exact_structured_vertical",
      root: verticalRoot,
      report_name: structuredVerticalReportName,
      precreate_report: false,
      lifecycle_entry: false,
      executable: input.node_bin,
      args: [
        input.vitest_entry,
        "run",
        join(
          repositoryRoot,
          "packages/server/src/codex-structured-vertical.smoke.test.ts"
        ),
        "--pool=threads",
        "--maxWorkers=1"
      ],
      cwd: repositoryRoot,
      env: scenarioEnvironment(baseEnvironment, verticalRoot, {
        HOSTDECK_CODEX_BIN: input.codex_bin,
        HOSTDECK_CODEX_VERTICAL_REPORT: join(
          verticalRoot,
          structuredVerticalReportName
        ),
        HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE: "1"
      }),
      timeout_ms: 420_000,
      max_output_bytes: 256 * 1_024
    }),
    ...lifecycle.map(fromLifecycleEntry)
  ]);
}

export async function runRuntimeHardeningScenarioManifest<Result>(
  manifest: readonly RuntimeHardeningManifestEntry[],
  execute: (entry: RuntimeHardeningManifestEntry) => Promise<Result>
): Promise<readonly Result[]> {
  const results: Result[] = [];
  for (const entry of manifest) results.push(await execute(entry));
  return Object.freeze(results);
}

function fromLifecycleEntry(
  input: LifecycleScenarioManifestEntry
): RuntimeHardeningManifestEntry {
  return Object.freeze({
    ...input,
    lifecycle_entry: true
  });
}

function entry(
  input: Omit<RuntimeHardeningManifestEntry, "command" | "report_path"> &
    Omit<OwnedLifecycleScenarioCommand, "scenario">
): RuntimeHardeningManifestEntry {
  const reportPath = join(input.root, input.report_name);
  return Object.freeze({
    name: input.name,
    root: input.root,
    report_name: input.report_name,
    report_path: reportPath,
    precreate_report: input.precreate_report,
    lifecycle_entry: input.lifecycle_entry,
    command: Object.freeze({
      scenario: input.name,
      executable: input.executable,
      args: Object.freeze([...input.args]),
      cwd: input.cwd,
      env: Object.freeze({ ...input.env }),
      timeout_ms: input.timeout_ms,
      max_output_bytes: input.max_output_bytes
    })
  });
}

function sanitizedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !name.startsWith("HOSTDECK_CODEX_") &&
      !name.startsWith("HOSTDECK_REQUIRE_CODEX_") &&
      !name.startsWith("VITEST_") &&
      name !== "CODEX_HOME" &&
      name !== "TEMP" &&
      name !== "TMP" &&
      name !== "TMPDIR"
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

function scenarioEnvironment(
  base: NodeJS.ProcessEnv,
  root: string,
  exact: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...exact,
    TEMP: root,
    TMP: root,
    TMPDIR: root
  };
}
