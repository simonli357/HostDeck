import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeHardeningScenarioManifest,
  runtimeHardeningDeterministicTests,
  runtimeHardeningScenarioNames
} from "./codex-runtime-hardening-manifest.js";

const repositoryRoot = resolve(process.cwd());
const requireFromHere = createRequire(import.meta.url);
const vitestEntry = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);

describe("runtime hardening manifest", () => {
  it("freezes the selected deterministic file inventory", () => {
    expect([...runtimeHardeningDeterministicTests]).toEqual(
      discoverDeterministicTests()
    );
    expect(new Set(runtimeHardeningDeterministicTests).size).toBe(
      runtimeHardeningDeterministicTests.length
    );
  });

  it("builds six fixed isolated scenarios without caller overrides", () => {
    const root = "/tmp/hd-rh-manifest";
    const manifest = createRuntimeHardeningScenarioManifest({
      repository_root: repositoryRoot,
      outer_root: root,
      node_bin: process.execPath,
      vitest_entry: vitestEntry,
      codex_bin: "/tmp/codex-0.144.0",
      base_env: {
        PATH: process.env.PATH,
        HOSTDECK_CODEX_BIN: "/private/wrong",
        HOSTDECK_CODEX_VERTICAL_REPORT: "/private/wrong-report",
        HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE: "0",
        VITEST_POOL_ID: "private-pool",
        CODEX_HOME: "/private/codex-home",
        TMPDIR: "/private/tmp"
      }
    });

    expect(manifest.map((entry) => entry.name)).toEqual(
      runtimeHardeningScenarioNames
    );
    expect(manifest.map((entry) => entry.root)).toEqual([
      `${root}/d0`,
      `${root}/v0`,
      `${root}/s0`,
      `${root}/s1`,
      `${root}/s2`,
      `${root}/s3`
    ]);
    expect(manifest.map((entry) => entry.report_name)).toEqual([
      "deterministic-report.json",
      "structured-vertical-report.json",
      "integration-report.json",
      "supervisor-report.json",
      "restart-report.json",
      "coexistence-report.json"
    ]);
    expect(manifest.map((entry) => entry.precreate_report)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false
    ]);
    expect(manifest.map((entry) => entry.lifecycle_entry)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true
    ]);
    for (const entry of manifest) {
      expect(entry.command.env.TMPDIR).toBe(entry.root);
      expect(entry.command.env.TEMP).toBe(entry.root);
      expect(entry.command.env.TMP).toBe(entry.root);
      expect(entry.command.env.VITEST_POOL_ID).toBeUndefined();
      expect(entry.command.env.CODEX_HOME).toBeUndefined();
      expect(entry.command.args).not.toContain("/private/wrong");
      expect(entry.command.args).not.toContain("/private/wrong-report");
    }
    expect(manifest[1]?.command.env.HOSTDECK_CODEX_BIN).toBe(
      "/tmp/codex-0.144.0"
    );
    expect(manifest[1]?.command.env.HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE).toBe(
      "1"
    );
    expect(manifest[0]?.command.args).toContain(
      join(repositoryRoot, "vitest.codex.config.ts")
    );
  });
});

function discoverDeterministicTests(): string[] {
  const adapterRoot = join(repositoryRoot, "packages/codex-adapter/src");
  const serverRoot = join(repositoryRoot, "packages/server/src");
  const adapter = readdirSync(adapterRoot)
    .filter(isIncludedTest)
    .map((name) => `packages/codex-adapter/src/${name}`);
  const server = readdirSync(serverRoot)
    .filter(
      (name) =>
        isIncludedTest(name) &&
        (name.startsWith("codex-") ||
          name === "managed-thread-service.test.ts" ||
          name === "pending-turn-settings.test.ts")
    )
    .map((name) => `packages/server/src/${name}`);
  return [...adapter, ...server].sort();
}

function isIncludedTest(name: string): boolean {
  return (
    name.endsWith(".test.ts") &&
    !name.endsWith(".smoke.test.ts") &&
    !name.endsWith(".worker.test.ts")
  );
}
