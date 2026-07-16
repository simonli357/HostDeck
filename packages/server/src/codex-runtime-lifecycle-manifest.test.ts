import { describe, expect, it, vi } from "vitest";
import {
  createLifecycleScenarioManifest,
  lifecycleScenarioNames,
  runLifecycleScenarioManifest
} from "./codex-runtime-lifecycle-manifest.js";

describe("runtime lifecycle scenario manifest", () => {
  it("freezes the exact ordered files, argv, reports, gates, and roots", () => {
    const manifest = createLifecycleScenarioManifest(input());

    expect(manifest.map((entry) => entry.name)).toEqual(lifecycleScenarioNames);
    expect(manifest.map((entry) => entry.report_name)).toEqual([
      "integration-report.json",
      "supervisor-report.json",
      "restart-report.json",
      "coexistence-report.json"
    ]);
    expect(manifest.map((entry) => entry.precreate_report)).toEqual([
      true,
      false,
      false,
      false
    ]);
    expect(new Set(manifest.map((entry) => entry.root)).size).toBe(4);
    expect(manifest[0]?.command.args).toContain(
      "/repo/tests/codex-reconnect-controller.integration.test.ts"
    );
    expect(manifest[0]?.command.args).toContain(
      "/repo/tests/codex-runtime-crash-reconciliation.integration.test.ts"
    );
    expect(manifest[1]?.command.args).toContain(
      "/repo/packages/server/src/codex-runtime-supervisor.smoke.test.ts"
    );
    expect(manifest[2]?.command.args).toContain(
      "/repo/packages/server/src/codex-hostdeck-restart.smoke.test.ts"
    );
    expect(manifest[3]?.command.args).toContain(
      "/repo/packages/server/src/codex-hostdeck-tui-coexistence.smoke.test.ts"
    );
    expect(manifest[1]?.command.env).toMatchObject({
      HOSTDECK_CODEX_BIN: "/codex",
      HOSTDECK_CODEX_SUPERVISOR_REPORT:
        "/outer/exact_supervisor/supervisor-report.json",
      HOSTDECK_REQUIRE_CODEX_SUPERVISOR_SMOKE: "1",
      TMPDIR: "/outer/exact_supervisor"
    });
    expect(manifest[2]?.command.env.HOSTDECK_CODEX_RESTART_REPORT).toBe(
      "/outer/exact_hostdeck_restart/restart-report.json"
    );
    expect(
      manifest[3]?.command.env.HOSTDECK_CODEX_TUI_COEXISTENCE_REPORT
    ).toBe("/outer/exact_tui_coexistence/coexistence-report.json");
    expect(manifest[0]?.command.env.HOSTDECK_CODEX_RESTART_REPORT).toBeUndefined();
    expect(manifest[0]?.command.env.HOSTDECK_REQUIRE_CODEX_LIFECYCLE_ACCEPTANCE)
      .toBeUndefined();
    expect(manifest.every((entry) => Object.isFrozen(entry.command.args))).toBe(
      true
    );
  });

  it("executes once in order and stops without retry after failure", async () => {
    const manifest = createLifecycleScenarioManifest(input());
    const execute = vi.fn(async (entry: (typeof manifest)[number]) => {
      if (entry.name === "exact_supervisor") throw new Error("failed");
      return entry.name;
    });

    await expect(runLifecycleScenarioManifest(manifest, execute)).rejects.toThrow(
      "failed"
    );
    expect(execute.mock.calls.map(([entry]) => entry.name)).toEqual([
      "headless_reconnect_crash",
      "exact_supervisor"
    ]);
  });
});

function input() {
  return {
    repository_root: "/repo",
    outer_root: "/outer",
    node_bin: "/node",
    vitest_entry: "/vitest.mjs",
    codex_bin: "/codex",
    base_env: {
      PATH: "/bin",
      HOSTDECK_CODEX_RESTART_REPORT: "/attacker",
      HOSTDECK_REQUIRE_CODEX_LIFECYCLE_ACCEPTANCE: "1"
    }
  };
}
