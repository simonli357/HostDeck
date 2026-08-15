import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSharedRuntimeHardeningManifest,
  sharedRuntimeHardeningDeterministicTests
} from "./shared-runtime-hardening-manifest.js";

describe("shared runtime hardening manifest", () => {
  it("freezes one bounded deterministic and one exact real scenario", () => {
    const root = resolve("/tmp/hostdeck-shared-runtime-manifest");
    const manifest = createSharedRuntimeHardeningManifest({
      repository_root: process.cwd(),
      outer_root: root,
      node_bin: process.execPath,
      vitest_entry: resolve("node_modules/vitest/vitest.mjs"),
      codex_bin: resolve("node_modules/@openai/codex/bin/codex.js"),
      expected_commit: "a".repeat(40),
      base_env: {
        PATH: process.env.PATH,
        CODEX_HOME: "/private/codex",
        HOSTDECK_REQUIRE_OLD: "1",
        HOSTDECK_SHARED_RUNTIME_OLD: "private",
        VITEST_POOL_ID: "private"
      }
    });

    expect(manifest.map((entry) => entry.name)).toEqual([
      "deterministic_shared_runtime",
      "exact_multi_project"
    ]);
    expect(manifest.every(Object.isFrozen)).toBe(true);
    expect(manifest.every((entry) => Object.isFrozen(entry.command))).toBe(true);
    expect(manifest[0]?.precreate_report).toBe(true);
    expect(manifest[1]?.precreate_report).toBe(false);
    expect(manifest[1]?.command.env).toMatchObject({
      HOSTDECK_EXPECTED_COMMIT: "a".repeat(40),
      HOSTDECK_REQUIRE_SHARED_CODEX_SESSIONS_SMOKE: "1"
    });
    expect(manifest[0]?.command.env).not.toHaveProperty("CODEX_HOME");
    expect(manifest[0]?.command.env).not.toHaveProperty("HOSTDECK_REQUIRE_OLD");
    expect(manifest[0]?.command.env).not.toHaveProperty(
      "HOSTDECK_SHARED_RUNTIME_OLD"
    );
    expect(manifest[0]?.command.env).not.toHaveProperty("VITEST_POOL_ID");
    expect(sharedRuntimeHardeningDeterministicTests).toHaveLength(32);
    expect([...sharedRuntimeHardeningDeterministicTests]).toEqual(
      [...sharedRuntimeHardeningDeterministicTests].sort()
    );
  });
});
