import { defineConfig } from "vitest/config";
import { sharedRuntimeHardeningDeterministicTests } from "./packages/server/src/shared-runtime-hardening-manifest.js";

export default defineConfig({
  test: {
    include: [...sharedRuntimeHardeningDeterministicTests],
    passWithNoTests: false
  }
});
