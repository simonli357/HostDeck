import { join, resolve } from "node:path";
import type { OwnedLifecycleScenarioCommand } from "./codex-runtime-lifecycle-process.js";

export const sharedRuntimeHardeningDeterministicTests = Object.freeze([
  "packages/cli/src/broker-cli.test.ts",
  "packages/cli/src/selected-api-route-inventory.test.ts",
  "packages/codex-adapter/src/connection.test.ts",
  "packages/codex-adapter/src/loaded-thread-client.test.ts",
  "packages/codex-adapter/src/reconnect-controller.test.ts",
  "packages/codex-adapter/src/transport-endpoint.test.ts",
  "packages/codex-adapter/src/tui-resume.test.ts",
  "packages/contracts/src/session-enrollment.contract.test.ts",
  "packages/contracts/src/shared-codex-runtime.contract.test.ts",
  "packages/server/src/automatic-session-enrollment-service.test.ts",
  "packages/server/src/catalog-publishing-state-repository.test.ts",
  "packages/server/src/codex-event-pipeline.test.ts",
  "packages/server/src/codex-prompt-control-service.test.ts",
  "packages/server/src/codex-runtime-lifecycle-acceptance.failure.test.ts",
  "packages/server/src/codex-runtime-reconciliation-lifecycle.test.ts",
  "packages/server/src/foreground-resource-bootstrap.test.ts",
  "packages/server/src/production-application-composition.test.ts",
  "packages/server/src/session-catalog-hub.test.ts",
  "packages/server/src/session-catalog-routes.test.ts",
  "packages/server/src/session-catalog-state-reader.test.ts",
  "packages/server/src/shared-codex-broker-lifecycle.test.ts",
  "packages/server/src/shared-codex-broker-node.test.ts",
  "packages/server/src/shared-runtime-hardening-manifest.test.ts",
  "packages/server/src/shared-runtime-hardening.test.ts",
  "packages/storage/src/automatic-session-enrollment.test.ts",
  "packages/storage/src/selected-state-repository.test.ts",
  "packages/web/src/connection-state.test.ts",
  "packages/web/src/mission-control.test.tsx",
  "packages/web/src/responsive-layout-state.test.ts",
  "packages/web/src/session-catalog-state.test.ts",
  "packages/web/src/session-detail.test.tsx",
  "packages/web/src/sse-client.test.ts"
] as const);

export const sharedRuntimeHardeningScenarioNames = Object.freeze([
  "deterministic_shared_runtime",
  "exact_multi_project"
] as const);

export type SharedRuntimeHardeningScenarioName =
  (typeof sharedRuntimeHardeningScenarioNames)[number];

export interface SharedRuntimeHardeningManifestInput {
  readonly repository_root: string;
  readonly outer_root: string;
  readonly node_bin: string;
  readonly vitest_entry: string;
  readonly codex_bin: string;
  readonly expected_commit: string;
  readonly base_env: NodeJS.ProcessEnv;
}

export interface SharedRuntimeHardeningManifestEntry {
  readonly name: SharedRuntimeHardeningScenarioName;
  readonly root: string;
  readonly report_name: string;
  readonly report_path: string;
  readonly precreate_report: boolean;
  readonly command: OwnedLifecycleScenarioCommand;
}

export function createSharedRuntimeHardeningManifest(
  input: SharedRuntimeHardeningManifestInput
): readonly SharedRuntimeHardeningManifestEntry[] {
  const repositoryRoot = resolve(input.repository_root);
  const baseEnvironment = sanitizedEnvironment(input.base_env);
  const deterministicRoot = join(input.outer_root, "d0");
  const realRoot = join(input.outer_root, "r0");
  return Object.freeze([
    entry({
      name: "deterministic_shared_runtime",
      root: deterministicRoot,
      report_name: "deterministic-report.json",
      precreate_report: true,
      executable: input.node_bin,
      args: [
        input.vitest_entry,
        "run",
        "--config",
        join(repositoryRoot, "vitest.shared-runtime.config.ts"),
        "--reporter=json",
        `--outputFile=${join(deterministicRoot, "deterministic-report.json")}`,
        "--pool=threads",
        "--maxWorkers=2"
      ],
      cwd: repositoryRoot,
      env: scenarioEnvironment(baseEnvironment, deterministicRoot, {}),
      timeout_ms: 240_000,
      max_output_bytes: 512 * 1_024
    }),
    entry({
      name: "exact_multi_project",
      root: realRoot,
      report_name: "multi-project-report.json",
      precreate_report: false,
      executable: input.node_bin,
      args: [
        input.vitest_entry,
        "run",
        join(
          repositoryRoot,
          "packages/server/src/automatic-session-enrollment-real.smoke.test.ts"
        ),
        "--pool=threads",
        "--maxWorkers=1"
      ],
      cwd: repositoryRoot,
      env: scenarioEnvironment(baseEnvironment, realRoot, {
        HOSTDECK_CODEX_BIN: input.codex_bin,
        HOSTDECK_EXPECTED_COMMIT: input.expected_commit,
        HOSTDECK_SHARED_RUNTIME_REPORT: join(
          realRoot,
          "multi-project-report.json"
        ),
        HOSTDECK_REQUIRE_SHARED_CODEX_SESSIONS_SMOKE: "1"
      }),
      timeout_ms: 120_000,
      max_output_bytes: 256 * 1_024
    })
  ]);
}

function entry(
  input: Omit<SharedRuntimeHardeningManifestEntry, "command" | "report_path"> &
    Omit<OwnedLifecycleScenarioCommand, "scenario">
): SharedRuntimeHardeningManifestEntry {
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

function sanitizedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !name.startsWith("HOSTDECK_CODEX_") &&
      !name.startsWith("HOSTDECK_REQUIRE_") &&
      !name.startsWith("HOSTDECK_SHARED_RUNTIME_") &&
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
