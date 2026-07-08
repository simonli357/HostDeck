import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.contract.test.ts"],
    passWithNoTests: false
  }
});
