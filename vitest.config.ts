import { defineConfig } from "vitest/config";

import { vitestHookTimeoutMs, vitestMaxWorkers, vitestTestTimeoutMs } from "./vitest.workers.js";

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers,
    testTimeout: vitestTestTimeoutMs,
    hookTimeout: vitestHookTimeoutMs,
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/*.contract.test.ts", "**/*.integration.test.ts"],
    passWithNoTests: false
  }
});
