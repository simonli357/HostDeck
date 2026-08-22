import { defineConfig } from "vitest/config";

import { vitestHookTimeoutMs, vitestMaxWorkers, vitestTestTimeoutMs } from "./vitest.workers.js";

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers,
    testTimeout: vitestTestTimeoutMs,
    hookTimeout: vitestHookTimeoutMs,
    include: [
      "packages/codex-adapter/src/*.test.ts",
      "packages/server/src/codex-*.test.ts",
      "packages/server/src/managed-thread-service.test.ts",
      "packages/server/src/pending-turn-settings.test.ts"
    ],
    exclude: [
      "**/node_modules/**",
      "**/*.smoke.test.ts",
      "**/*.worker.test.ts"
    ],
    passWithNoTests: false
  }
});
