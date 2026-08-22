import { defineConfig } from "vitest/config";

import { vitestHookTimeoutMs, vitestMaxWorkers, vitestTestTimeoutMs } from "./vitest.workers.js";

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers,
    testTimeout: vitestTestTimeoutMs,
    hookTimeout: vitestHookTimeoutMs,
    include: ["packages/**/*.contract.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false
  }
});
