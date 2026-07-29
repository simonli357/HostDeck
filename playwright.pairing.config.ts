import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    "accessibility-pairing.spec.ts",
    "copy-workflow-pairing.spec.ts",
    "pairing-bootstrap.spec.ts",
    "pairing-access.spec.ts",
    "responsive-pairing-layout.spec.ts"
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"]],
  outputDir: "/tmp/hostdeck-playwright-pairing",
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    headless: true,
    trace: "off"
  },
  webServer: {
    command: "pnpm exec vite --config vite.pairing.config.ts --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
