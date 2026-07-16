import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const vitestEntry = join(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);
const reportPath = resolve(
  `artifacts/int-v1-032-rejected-fixture-${process.pid}.json`
);

afterEach(() => rmSync(reportPath, { force: true }));

describe("runtime lifecycle acceptance failure publication", () => {
  it("publishes no aggregate artifact when setup is rejected", () => {
    rmSync(reportPath, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        vitestEntry,
        "run",
        resolve(
          "packages/server/src/codex-runtime-lifecycle-acceptance.smoke.test.ts"
        ),
        "--pool=threads",
        "--maxWorkers=1"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOSTDECK_CODEX_BIN: "/hostdeck-missing/codex",
          HOSTDECK_CODEX_LIFECYCLE_REPORT: reportPath,
          HOSTDECK_REQUIRE_CODEX_LIFECYCLE_ACCEPTANCE: "1"
        },
        maxBuffer: 64 * 1_024,
        timeout: 20_000
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(existsSync(reportPath)).toBe(false);
  });
});
