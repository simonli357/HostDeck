import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.contract.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false
  }
});
