import { join, resolve } from "node:path";
import { lifecycleIntegrationTests } from "./codex-runtime-lifecycle-acceptance.js";
import type { LifecycleScenarioReportName } from "./codex-runtime-lifecycle-files.js";
import type { OwnedLifecycleScenarioCommand } from "./codex-runtime-lifecycle-process.js";

export const lifecycleScenarioNames = Object.freeze([
  "headless_reconnect_crash",
  "exact_supervisor",
  "exact_hostdeck_restart",
  "exact_tui_coexistence"
] as const);

export type LifecycleScenarioName = (typeof lifecycleScenarioNames)[number];

export interface LifecycleScenarioManifestInput {
  readonly repository_root: string;
  readonly outer_root: string;
  readonly node_bin: string;
  readonly vitest_entry: string;
  readonly codex_bin: string;
  readonly base_env: NodeJS.ProcessEnv;
}

export interface LifecycleScenarioManifestEntry {
  readonly name: LifecycleScenarioName;
  readonly root: string;
  readonly report_name: LifecycleScenarioReportName;
  readonly report_path: string;
  readonly precreate_report: boolean;
  readonly command: OwnedLifecycleScenarioCommand;
}

const controlledEnvironmentNames = new Set([
  "HOSTDECK_CODEX_BIN",
  "HOSTDECK_CODEX_LIFECYCLE_REPORT",
  "HOSTDECK_CODEX_RESTART_REPORT",
  "HOSTDECK_CODEX_SUPERVISOR_REPORT",
  "HOSTDECK_CODEX_TUI_COEXISTENCE_REPORT",
  "HOSTDECK_REQUIRE_CODEX_LIFECYCLE_ACCEPTANCE",
  "HOSTDECK_REQUIRE_CODEX_RESTART_SMOKE",
  "HOSTDECK_REQUIRE_CODEX_SUPERVISOR_SMOKE",
  "HOSTDECK_REQUIRE_CODEX_TUI_COEXISTENCE_SMOKE",
  "TEMP",
  "TMP",
  "TMPDIR"
]);

export function createLifecycleScenarioManifest(
  input: LifecycleScenarioManifestInput
): readonly LifecycleScenarioManifestEntry[] {
  const repositoryRoot = resolve(input.repository_root);
  const integrationRoot = join(input.outer_root, "headless_reconnect_crash");
  const supervisorRoot = join(input.outer_root, "exact_supervisor");
  const restartRoot = join(input.outer_root, "exact_hostdeck_restart");
  const coexistenceRoot = join(input.outer_root, "exact_tui_coexistence");

  return Object.freeze([
    entry({
      name: "headless_reconnect_crash",
      root: integrationRoot,
      report_name: "integration-report.json",
      precreate_report: true,
      executable: input.node_bin,
      args: [
        input.vitest_entry,
        "run",
        "--config",
        join(repositoryRoot, "vitest.integration.config.ts"),
        "--reporter=json",
        `--outputFile=${join(integrationRoot, "integration-report.json")}`,
        "--pool=threads",
        "--maxWorkers=1",
        ...lifecycleIntegrationTests.map((path) => join(repositoryRoot, path))
      ],
      cwd: repositoryRoot,
      env: scenarioEnvironment(input.base_env, integrationRoot, {}),
      timeout_ms: 60_000,
      max_output_bytes: 256 * 1_024
    }),
    entry({
      name: "exact_supervisor",
      root: supervisorRoot,
      report_name: "supervisor-report.json",
      precreate_report: false,
      executable: input.node_bin,
      args: exactSmokeArgs(
        input.vitest_entry,
        repositoryRoot,
        "packages/server/src/codex-runtime-supervisor.smoke.test.ts"
      ),
      cwd: repositoryRoot,
      env: scenarioEnvironment(input.base_env, supervisorRoot, {
        HOSTDECK_CODEX_BIN: input.codex_bin,
        HOSTDECK_CODEX_SUPERVISOR_REPORT: join(
          supervisorRoot,
          "supervisor-report.json"
        ),
        HOSTDECK_REQUIRE_CODEX_SUPERVISOR_SMOKE: "1"
      }),
      timeout_ms: 45_000,
      max_output_bytes: 256 * 1_024
    }),
    entry({
      name: "exact_hostdeck_restart",
      root: restartRoot,
      report_name: "restart-report.json",
      precreate_report: false,
      executable: input.node_bin,
      args: exactSmokeArgs(
        input.vitest_entry,
        repositoryRoot,
        "packages/server/src/codex-hostdeck-restart.smoke.test.ts"
      ),
      cwd: repositoryRoot,
      env: scenarioEnvironment(input.base_env, restartRoot, {
        HOSTDECK_CODEX_BIN: input.codex_bin,
        HOSTDECK_CODEX_RESTART_REPORT: join(
          restartRoot,
          "restart-report.json"
        ),
        HOSTDECK_REQUIRE_CODEX_RESTART_SMOKE: "1"
      }),
      timeout_ms: 280_000,
      max_output_bytes: 256 * 1_024
    }),
    entry({
      name: "exact_tui_coexistence",
      root: coexistenceRoot,
      report_name: "coexistence-report.json",
      precreate_report: false,
      executable: input.node_bin,
      args: exactSmokeArgs(
        input.vitest_entry,
        repositoryRoot,
        "packages/server/src/codex-hostdeck-tui-coexistence.smoke.test.ts"
      ),
      cwd: repositoryRoot,
      env: scenarioEnvironment(input.base_env, coexistenceRoot, {
        HOSTDECK_CODEX_BIN: input.codex_bin,
        HOSTDECK_CODEX_TUI_COEXISTENCE_REPORT: join(
          coexistenceRoot,
          "coexistence-report.json"
        ),
        HOSTDECK_REQUIRE_CODEX_TUI_COEXISTENCE_SMOKE: "1"
      }),
      timeout_ms: 280_000,
      max_output_bytes: 256 * 1_024
    })
  ]);
}

export async function runLifecycleScenarioManifest<Result>(
  manifest: readonly LifecycleScenarioManifestEntry[],
  execute: (entry: LifecycleScenarioManifestEntry) => Promise<Result>
): Promise<readonly Result[]> {
  const results: Result[] = [];
  for (const entry of manifest) results.push(await execute(entry));
  return Object.freeze(results);
}

function entry(
  input: Omit<LifecycleScenarioManifestEntry, "command" | "report_path"> &
    Omit<OwnedLifecycleScenarioCommand, "scenario">
): LifecycleScenarioManifestEntry {
  const reportPath = join(input.root, input.report_name);
  return Object.freeze({
    name: input.name,
    root: input.root,
    report_name: input.report_name,
    report_path: reportPath,
    precreate_report: input.precreate_report,
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

function exactSmokeArgs(
  vitestEntry: string,
  repositoryRoot: string,
  testPath: string
): readonly string[] {
  return [
    vitestEntry,
    "run",
    join(repositoryRoot, testPath),
    "--pool=threads",
    "--maxWorkers=1"
  ];
}

function scenarioEnvironment(
  base: NodeJS.ProcessEnv,
  root: string,
  exact: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !controlledEnvironmentNames.has(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    ...exact,
    TEMP: root,
    TMP: root,
    TMPDIR: root
  };
}
