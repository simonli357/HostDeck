import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/*.contract.test.ts", "**/*.integration.test.ts"],
    passWithNoTests: false
  }
});
